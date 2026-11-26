package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// An app's lifecycle is driven by its intent (app_intents, written by the
// API) and the controller's progress on it (app_runtime, written here). See
// #354. The controller claims an app with a lease, reads its effective intent,
// and makes each Kubernetes change inside Fence, which checks under a lock
// that the intent and the lease are still the ones it is working on.

// AppLeaseTTL is how long an app's lease lasts without a heartbeat before
// another poll may claim the app again, e.g. after the controller crashed.
// Much longer than the heartbeat interval, so a slow DB write never trips it.
const AppLeaseTTL = 2 * time.Minute

// ErrIntentChanged is returned by Fence when the app's intent has moved on
// from the generation being worked on, or the app is gone.
var ErrIntentChanged = errors.New("app intent changed")

// ErrLeaseLost is returned when this controller no longer holds the app's
// lease, because it expired and the app was claimed again.
var ErrLeaseLost = errors.New("app lease lost")

// ErrNotDeploying is returned by FinishDeploy when the attempt is no longer
// in progress, e.g. because it was superseded.
var ErrNotDeploying = errors.New("deployment is no longer deploying")

// Lease is this controller's claim on one app's lifecycle.
type Lease struct {
	AppID string
	Token string
}

// Writes from an API that predates intents (#354). During the upgrade's API
// rollout, old pods still deploy and stop without writing app_intents. Until
// the API stops writing the old markers (part 3 of #354), the controller reads
// them as intent:
//
//   - unrecordedDeploySQL finds a deployment created after the intent was last
//     written, which can only come from such a pod. It becomes the target.
//   - stopMarkerSQL finds the old Stop's teardown markers (a stopped row that
//     still has its manifest, or a failed attempt marked for teardown). Every
//     deploy clears them in the transaction that records its intent, so they
//     mean the app was stopped since. The app is torn down.
const (
	unrecordedDeploySQL = `
		SELECT d.id FROM deployments d
		WHERE d.app_id = i.app_id
		  AND d.status IN ('pending_deployment', 'deploying')
		  AND d.created_at > i.updated_at
		ORDER BY d.created_at DESC, d.id DESC
		LIMIT 1`
	stopMarkerSQL = `
		SELECT 1 FROM deployments d
		WHERE d.app_id = i.app_id
		  AND (d.teardown_requested_at IS NOT NULL
		       OR (d.status = 'stopped' AND d.applied_manifest IS NOT NULL))`
)

// ClaimApps claims up to limit apps that need lifecycle work and whose lease
// is free or expired, skipping the apps in running (this process's workers).
// An app needs work when its intent's generation is ahead of what was
// reconciled, unless its target is still being built (there is nothing to do
// until the builder hands it over), or when an old API left writes behind.
func (s *Store) ClaimApps(ctx context.Context, limit int, running []string) ([]Lease, error) {
	if limit <= 0 {
		return nil, nil
	}
	if running == nil {
		running = []string{}
	}
	// Every app with an intent gets a runtime row to claim.
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO app_runtime (app_id)
		SELECT i.app_id FROM app_intents i
		WHERE NOT EXISTS (SELECT 1 FROM app_runtime r WHERE r.app_id = i.app_id)
		ON CONFLICT (app_id) DO NOTHING`); err != nil {
		return nil, fmt.Errorf("add runtime rows: %w", err)
	}

	now := time.Now().UTC()
	token := uuid.NewString()
	rows, err := s.db.QueryContext(ctx, `
		UPDATE app_runtime
		SET lease_token = $1, claimed_at = $2
		WHERE app_id IN (
			SELECT r.app_id FROM app_runtime r
			JOIN app_intents i ON i.app_id = r.app_id
			WHERE (r.claimed_at IS NULL OR r.claimed_at < $3)
			  AND NOT (r.app_id = ANY($4))
			  AND (
			    (i.generation > r.reconciled_generation
			     AND NOT (i.desired_state = 'running' AND EXISTS (
			       SELECT 1 FROM deployments t
			       WHERE t.id = i.target_deployment_id
			         AND t.status IN ('pending_build', 'building', 'scanning'))))
			    OR EXISTS (`+unrecordedDeploySQL+`)
			    OR EXISTS (`+stopMarkerSQL+`)
			  )
			ORDER BY i.updated_at ASC
			LIMIT $5
			FOR UPDATE OF r SKIP LOCKED
		)
		RETURNING app_id`,
		token, now, now.Add(-AppLeaseTTL), running, limit)
	if err != nil {
		return nil, fmt.Errorf("claim apps: %w", err)
	}
	defer rows.Close()
	var leases []Lease
	for rows.Next() {
		l := Lease{Token: token}
		if err := rows.Scan(&l.AppID); err != nil {
			return nil, fmt.Errorf("scan claimed app: %w", err)
		}
		leases = append(leases, l)
	}
	return leases, rows.Err()
}

// Heartbeat renews the lease. It returns ErrLeaseLost when the lease is no
// longer this controller's.
func (s *Store) Heartbeat(ctx context.Context, l Lease) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE app_runtime SET claimed_at = $1
		WHERE app_id = $2 AND lease_token = $3`, time.Now().UTC(), l.AppID, l.Token)
	if err != nil {
		return fmt.Errorf("heartbeat: %w", err)
	}
	return requireRow(res, ErrLeaseLost)
}

// Release gives up the lease, so a later poll can claim the app at once.
func (s *Store) Release(ctx context.Context, l Lease) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE app_runtime SET lease_token = NULL, claimed_at = NULL
		WHERE app_id = $1 AND lease_token = $2`, l.AppID, l.Token)
	if err != nil {
		return fmt.Errorf("release lease: %w", err)
	}
	return nil
}

// ReleaseAllLeases gives up every app's lease. The controller calls it once
// at startup: the chart runs a single controller (strategy Recreate), so any
// lease still held belongs to a process that is gone, and its apps can be
// resumed at once instead of after AppLeaseTTL. Even a worker that somehow
// still ran would lose: its next Fence fails on the token.
func (s *Store) ReleaseAllLeases(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE app_runtime SET lease_token = NULL, claimed_at = NULL WHERE lease_token IS NOT NULL`)
	if err != nil {
		return 0, fmt.Errorf("release all leases: %w", err)
	}
	return res.RowsAffected()
}

// Intent is an app's effective intent: app_intents, adjusted for writes from
// an API that predates intents (see unrecordedDeploySQL).
type Intent struct {
	AppID      string
	Generation int64
	Desired    string // "running" | "stopped"

	// Target is the deployment that should run, nil when there is none.
	// TargetStatus is its status. TargetErr is set when its snapshot can't be
	// read, which fails the attempt.
	Target       *DeployingDeployment
	TargetStatus string
	TargetErr    error

	// The app's current names, which its resources are torn down under.
	AppSlug     string
	ProjectID   string
	ProjectSlug string

	// Reconciled is the generation the controller has finished.
	// Unrecorded and StopMarker report writes from an API that predates
	// intents (see unrecordedDeploySQL), which Desired and Target already
	// account for.
	Reconciled int64
	Unrecorded bool
	StopMarker bool
}

// NeedsWork reports whether the controller has something to do for the
// intent, by the same rule as ClaimApps.
func (in *Intent) NeedsWork() bool {
	if in.Unrecorded || in.StopMarker {
		return true
	}
	if in.Generation <= in.Reconciled {
		return false
	}
	building := in.TargetStatus == "pending_build" || in.TargetStatus == "building" || in.TargetStatus == "scanning"
	return in.Desired != "running" || !building
}

// ReadIntent returns the app's effective intent, or nil when the app is gone.
func (s *Store) ReadIntent(ctx context.Context, appID string) (*Intent, error) {
	in := Intent{AppID: appID}
	var target, unrecorded sql.NullString
	var stopMarker bool
	err := s.db.QueryRowContext(ctx, `
		SELECT i.generation, i.desired_state, i.target_deployment_id,
		       a.slug, a.project_id, p.slug,
		       COALESCE(r.reconciled_generation, 0),
		       (`+unrecordedDeploySQL+`),
		       EXISTS (`+stopMarkerSQL+`)
		FROM app_intents i
		JOIN apps a ON a.id = i.app_id
		JOIN projects p ON p.id = a.project_id
		LEFT JOIN app_runtime r ON r.app_id = i.app_id
		WHERE i.app_id = $1`, appID).
		Scan(&in.Generation, &in.Desired, &target, &in.AppSlug, &in.ProjectID, &in.ProjectSlug,
			&in.Reconciled, &unrecorded, &stopMarker)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read intent: %w", err)
	}
	in.Unrecorded, in.StopMarker = unrecorded.Valid, stopMarker
	switch {
	case unrecorded.Valid:
		in.Desired, target = "running", unrecorded
	case stopMarker:
		in.Desired = "stopped"
	}
	if target.Valid {
		if err := s.loadTarget(ctx, &in, target.String); err != nil {
			return nil, err
		}
	}
	return &in, nil
}

func (s *Store) loadTarget(ctx context.Context, in *Intent, id string) error {
	d := DeployingDeployment{ID: id}
	var digest, sha, snapshotJSON, canetteConfig sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT app_id, status, image_digest, commit_sha, deployment_snapshot, canette_config
		FROM deployments WHERE id = $1`, id).
		Scan(&d.AppID, &in.TargetStatus, &digest, &sha, &snapshotJSON, &canetteConfig)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // deleted with its app since the intent was read
	}
	if err != nil {
		return fmt.Errorf("load target deployment: %w", err)
	}
	d.ImageDigest, d.CommitSha, d.CanetteConfig = digest.String, sha.String, canetteConfig.String
	in.TargetErr = d.parseSnapshot(snapshotJSON.String)
	in.Target = &d
	return nil
}

// Fence runs step, a Kubernetes change for the app, while holding a share
// lock on its intent and its runtime row, after checking that the intent is
// still at generation and the lease still this controller's. The API changes
// an intent under FOR UPDATE, so it waits for the step instead of changing the
// intent halfway through it, and an expired lease can't be claimed during it.
//
// If the commit fails after step ran, the change may or may not have been
// made, and the caller must read the intent again rather than assume either.
func (s *Store) Fence(ctx context.Context, l Lease, generation int64, step func(context.Context) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("fence: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var current int64
	err = tx.QueryRowContext(ctx, `SELECT generation FROM app_intents WHERE app_id = $1 FOR SHARE`, l.AppID).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrIntentChanged
	}
	if err != nil {
		return fmt.Errorf("fence: lock intent: %w", err)
	}
	var held int
	err = tx.QueryRowContext(ctx, `
		SELECT 1 FROM app_runtime WHERE app_id = $1 AND lease_token = $2 FOR SHARE`, l.AppID, l.Token).Scan(&held)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrLeaseLost
	}
	if err != nil {
		return fmt.Errorf("fence: lock lease: %w", err)
	}
	if current != generation {
		return ErrIntentChanged
	}
	if err := step(ctx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("fence: commit: %w", err)
	}
	return nil
}

// StartDeploying moves the target from pending_deployment to deploying. It
// reports false, changing nothing, when the row is in another state.
func (s *Store) StartDeploying(ctx context.Context, deploymentID string) (bool, error) {
	now := time.Now().UTC()
	res, err := s.db.ExecContext(ctx, `
		UPDATE deployments SET status = 'deploying', claimed_at = $1, updated_at = $1
		WHERE id = $2 AND status = 'pending_deployment'`, now, deploymentID)
	if err != nil {
		return false, fmt.Errorf("start deploying: %w", err)
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// FinishDeploy records a successful rollout: the attempt is live, any other
// live attempt of the app is superseded, and the app's runtime row names it
// as the applied deployment, with its URL (NULL for private and cron apps).
// The app counts as reconciled up to generation, the generation the rollout
// was started for. ErrNotDeploying means the attempt moved on meanwhile, and
// nothing is changed.
func (s *Store) FinishDeploy(ctx context.Context, l Lease, generation int64, deploymentID string, liveURL sql.NullString) error {
	return s.inTx(ctx, "finish deploy", func(tx *sql.Tx) error {
		now := time.Now().UTC()
		res, err := tx.ExecContext(ctx, `
			UPDATE deployments SET status = 'live', updated_at = $1
			WHERE id = $2 AND status IN ('deploying', 'live')`, now, deploymentID)
		if err != nil {
			return err
		}
		if err := requireRow(res, ErrNotDeploying); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE deployments SET status = 'superseded', updated_at = $1
			WHERE app_id = (SELECT app_id FROM deployments WHERE id = $2)
			  AND status = 'live' AND id <> $2`, now, deploymentID); err != nil {
			return err
		}
		res, err = tx.ExecContext(ctx, `
			UPDATE app_runtime
			SET applied_deployment_id = $1, live_url = $2, last_error = NULL,
			    reconciled_generation = GREATEST(reconciled_generation, $3)
			WHERE app_id = $4 AND lease_token = $5`, deploymentID, liveURL, generation, l.AppID, l.Token)
		if err != nil {
			return err
		}
		return requireRow(res, ErrLeaseLost)
	})
}

// FailDeploy records a failed attempt and counts the app as reconciled up to
// generation, so the attempt isn't retried. An attempt that is no longer in
// progress keeps its status.
func (s *Store) FailDeploy(ctx context.Context, l Lease, generation int64, deploymentID, msg string) error {
	return s.inTx(ctx, "fail deploy", func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
			UPDATE deployments SET status = 'failed', error_message = $1, updated_at = $2
			WHERE id = $3 AND status IN ('pending_deployment', 'deploying')`,
			msg, time.Now().UTC(), deploymentID); err != nil {
			return err
		}
		return s.reconciled(ctx, tx, l, generation, msg)
	})
}

// MarkReconciled counts the app as reconciled up to generation, for an
// intent that needs no Kubernetes change.
func (s *Store) MarkReconciled(ctx context.Context, l Lease, generation int64) error {
	return s.inTx(ctx, "mark reconciled", func(tx *sql.Tx) error {
		return s.reconciled(ctx, tx, l, generation, "")
	})
}

// FinishStop records that the app's resources are torn down: attempts that
// were live or rolling out are stopped, one still waiting to be rolled out is
// superseded, the old Stop's teardown markers are cleared (see stopMarkerSQL),
// and the app has no applied deployment or URL any more.
func (s *Store) FinishStop(ctx context.Context, l Lease, generation int64) error {
	return s.inTx(ctx, "finish stop", func(tx *sql.Tx) error {
		now := time.Now().UTC()
		if _, err := tx.ExecContext(ctx, `
			UPDATE deployments SET status = 'stopped', error_message = NULL, updated_at = $1
			WHERE app_id = $2 AND status IN ('live', 'deploying')`, now, l.AppID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE deployments SET status = 'superseded', updated_at = $1
			WHERE app_id = $2 AND status = 'pending_deployment'`, now, l.AppID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE deployments
			SET applied_manifest = CASE WHEN status = 'stopped' THEN NULL ELSE applied_manifest END,
			    teardown_requested_at = NULL
			WHERE app_id = $1
			  AND (teardown_requested_at IS NOT NULL OR (status = 'stopped' AND applied_manifest IS NOT NULL))`,
			l.AppID); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `
			UPDATE app_runtime
			SET applied_deployment_id = NULL, live_url = NULL, last_error = NULL,
			    reconciled_generation = GREATEST(reconciled_generation, $1)
			WHERE app_id = $2 AND lease_token = $3`, generation, l.AppID, l.Token)
		if err != nil {
			return err
		}
		return requireRow(res, ErrLeaseLost)
	})
}

// Supersede ends an attempt that is no longer the app's target before it went
// live. It changes nothing when the attempt has already ended.
func (s *Store) Supersede(ctx context.Context, deploymentID string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE deployments SET status = 'superseded', updated_at = $1
		WHERE id = $2 AND status IN ('pending_deployment', 'deploying')`, time.Now().UTC(), deploymentID)
	if err != nil {
		return fmt.Errorf("supersede: %w", err)
	}
	return nil
}

// SweepSuperseded supersedes every attempt waiting to be rolled out that is
// no longer its app's target, or whose app should be stopped, e.g. a build
// that finished after a newer deploy or a Stop. An attempt created after its
// app's intent was last written is left alone (see unrecordedDeploySQL). It
// returns the IDs it superseded.
func (s *Store) SweepSuperseded(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		UPDATE deployments d SET status = 'superseded', updated_at = $1
		FROM app_intents i
		WHERE d.app_id = i.app_id
		  AND d.status = 'pending_deployment'
		  AND d.created_at <= i.updated_at
		  AND (i.desired_state = 'stopped' OR i.target_deployment_id IS DISTINCT FROM d.id)
		RETURNING d.id`, time.Now().UTC())
	if err != nil {
		return nil, fmt.Errorf("sweep superseded: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan superseded: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) reconciled(ctx context.Context, tx *sql.Tx, l Lease, generation int64, lastError string) error {
	res, err := tx.ExecContext(ctx, `
		UPDATE app_runtime
		SET reconciled_generation = GREATEST(reconciled_generation, $1), last_error = NULLIF($2, '')
		WHERE app_id = $3 AND lease_token = $4`, generation, lastError, l.AppID, l.Token)
	if err != nil {
		return err
	}
	return requireRow(res, ErrLeaseLost)
}

// inTx runs fn in a transaction, committing when it returns nil. Sentinel
// errors (ErrLeaseLost, ErrNotDeploying) pass through unwrapped.
func (s *Store) inTx(ctx context.Context, what string, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(tx); err != nil {
		if errors.Is(err, ErrLeaseLost) || errors.Is(err, ErrNotDeploying) {
			return err
		}
		return fmt.Errorf("%s: %w", what, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("%s: commit: %w", what, err)
	}
	return nil
}

// requireRow returns notFound when res affected no row.
func requireRow(res sql.Result, notFound error) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return notFound
	}
	return nil
}
