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
// #354. The controller claims an app with a lease, reads its intent, and makes
// each Kubernetes change inside Fence, which checks under a lock that the
// intent and the lease are still the ones it is working on.

// AppLeaseTTL is how long an app's lease lasts without a heartbeat before
// another poll may claim the app again, e.g. after the controller crashed.
// Much longer than the heartbeat interval, so a slow DB write never trips it.
const AppLeaseTTL = 2 * time.Minute

// FenceTimeout bounds a fenced change, including the Kubernetes calls in it,
// so a stalled request gives the intent lock and the worker back. Well above
// what an apply takes, including ApplyAll's wait for quota usage.
const FenceTimeout = time.Minute

// fenceTimeout is FenceTimeout, shortened by tests.
var fenceTimeout = FenceTimeout

// ErrIntentChanged is returned by Fence when the app's intent has moved on
// from the generation being worked on, or the app is gone.
var ErrIntentChanged = errors.New("app intent changed")

// ErrLeaseLost is returned when this controller no longer holds the app's
// lease, because it expired and the app was claimed again.
var ErrLeaseLost = errors.New("app lease lost")

// ErrFence wraps a failure of the fence's own database work (locking,
// recording, committing), as opposed to an error of the fenced step. After
// it, the Kubernetes change may or may not have been made, so the work must be
// resumed from the intent, not recorded as failed.
var ErrFence = errors.New("fence failed")

// ErrNotDeploying is returned by FinishDeploy when the attempt is no longer
// in progress, e.g. because it was superseded.
var ErrNotDeploying = errors.New("deployment is no longer deploying")

// Lease is this controller's claim on one app's lifecycle.
type Lease struct {
	AppID string
	Token string
}

// ClaimApps claims up to limit apps that need lifecycle work and whose lease
// is free or expired, skipping the apps in running (this process's workers).
// An app needs work when its intent's generation is ahead of what was
// reconciled, unless its target is still being built: there is nothing to do
// until the builder hands it over.
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
			  AND i.generation > r.reconciled_generation
			  AND NOT (i.desired_state = 'running' AND EXISTS (
			    SELECT 1 FROM deployments t
			    WHERE t.id = i.target_deployment_id
			      AND t.status IN ('pending_build', 'building', 'scanning')))
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

// Intent is an app's intent, with what the controller needs to act on it.
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
	Reconciled int64
}

// NeedsWork reports whether the controller has something to do for the
// intent, by the same rule as ClaimApps.
func (in *Intent) NeedsWork() bool {
	if in.Generation <= in.Reconciled {
		return false
	}
	building := in.TargetStatus == "pending_build" || in.TargetStatus == "building" || in.TargetStatus == "scanning"
	return in.Desired != "running" || !building
}

// ReadIntent returns the app's intent, or nil when the app is gone.
func (s *Store) ReadIntent(ctx context.Context, appID string) (*Intent, error) {
	in := Intent{AppID: appID}
	var target sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT i.generation, i.desired_state, i.target_deployment_id,
		       a.slug, a.project_id, p.slug,
		       COALESCE(r.reconciled_generation, 0)
		FROM app_intents i
		JOIN apps a ON a.id = i.app_id
		JOIN projects p ON p.id = a.project_id
		LEFT JOIN app_runtime r ON r.app_id = i.app_id
		WHERE i.app_id = $1`, appID).
		Scan(&in.Generation, &in.Desired, &target, &in.AppSlug, &in.ProjectID, &in.ProjectSlug, &in.Reconciled)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read intent: %w", err)
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
// The whole fence is bounded by FenceTimeout.
//
// An error of step is returned as is. A failure of the fence's own database
// work wraps ErrFence: the change may or may not have been made, and the
// caller must resume from the intent rather than assume either.
func (s *Store) Fence(ctx context.Context, l Lease, generation int64, step func(context.Context) error) error {
	return s.fence(ctx, l, generation, step, nil)
}

// FenceStop runs teardown like Fence, and records the stop in the same
// transaction, before the lock is released: attempts that were live or rolling
// out are stopped, one still waiting to be rolled out is superseded, and the
// app has no applied deployment or URL any more. Recording it under the lock means a
// deploy accepted after the teardown can't be swept up by it.
func (s *Store) FenceStop(ctx context.Context, l Lease, generation int64, teardown func(context.Context) error) error {
	return s.fence(ctx, l, generation, teardown, func(ctx context.Context, tx *sql.Tx) error {
		return recordStop(ctx, tx, l, generation)
	})
}

func (s *Store) fence(ctx context.Context, l Lease, generation int64, step func(context.Context) error, record func(context.Context, *sql.Tx) error) error {
	ctx, cancel := context.WithTimeout(ctx, fenceTimeout)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("%w: begin: %w", ErrFence, err)
	}
	defer func() { _ = tx.Rollback() }()

	var current int64
	err = tx.QueryRowContext(ctx, `SELECT generation FROM app_intents WHERE app_id = $1 FOR SHARE`, l.AppID).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrIntentChanged
	}
	if err != nil {
		return fmt.Errorf("%w: lock intent: %w", ErrFence, err)
	}
	var held int
	err = tx.QueryRowContext(ctx, `
		SELECT 1 FROM app_runtime WHERE app_id = $1 AND lease_token = $2 FOR SHARE`, l.AppID, l.Token).Scan(&held)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrLeaseLost
	}
	if err != nil {
		return fmt.Errorf("%w: lock lease: %w", ErrFence, err)
	}
	if current != generation {
		return ErrIntentChanged
	}
	if err := step(ctx); err != nil {
		return err
	}
	if record != nil {
		if err := record(ctx, tx); err != nil {
			if errors.Is(err, ErrLeaseLost) {
				return err
			}
			return fmt.Errorf("%w: record: %w", ErrFence, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("%w: commit: %w", ErrFence, err)
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
// live or rolling-out attempt of the app is superseded (see retireOthers), and
// the app's runtime row names it
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
			WHERE app_id = $2 AND status IN ('live', 'deploying') AND id <> $3`, now, l.AppID, deploymentID); err != nil {
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
// progress keeps its status. Other rolling-out attempts are retired.
func (s *Store) FailDeploy(ctx context.Context, l Lease, generation int64, deploymentID, msg string) error {
	return s.inTx(ctx, "fail deploy", func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
			UPDATE deployments SET status = 'failed', error_message = $1, updated_at = $2
			WHERE id = $3 AND status IN ('pending_deployment', 'deploying')`,
			msg, time.Now().UTC(), deploymentID); err != nil {
			return err
		}
		if err := retireOthers(ctx, tx, l.AppID, deploymentID); err != nil {
			return err
		}
		return s.reconciled(ctx, tx, l, generation, msg)
	})
}

// MarkReconciled counts the app as reconciled up to generation, for an
// intent that needs no Kubernetes change: its target (target, empty if none)
// failed, ended or doesn't exist. Other rolling-out attempts are retired.
func (s *Store) MarkReconciled(ctx context.Context, l Lease, generation int64, target string) error {
	return s.inTx(ctx, "mark reconciled", func(tx *sql.Tx) error {
		if err := retireOthers(ctx, tx, l.AppID, target); err != nil {
			return err
		}
		return s.reconciled(ctx, tx, l, generation, "")
	})
}

// retireOthers supersedes the app's attempts still marked deploying, other
// than keep, once its worker has settled its target. Normally the worker
// supersedes an attempt it stops waiting for, but one whose wait was cut off
// (a controller restart while a newer target was being built) is left
// deploying, with no worker for it. It must not linger: it isn't the target,
// and attempts in progress make admin force sync skip the app.
func retireOthers(ctx context.Context, tx *sql.Tx, appID, keep string) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE deployments SET status = 'superseded', updated_at = $1
		WHERE app_id = $2 AND status = 'deploying' AND id <> $3`, time.Now().UTC(), appID, keep)
	return err
}

// recordStop records a finished teardown, see FenceStop.
func recordStop(ctx context.Context, tx *sql.Tx, l Lease, generation int64) error {
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
	res, err := tx.ExecContext(ctx, `
		UPDATE app_runtime
		SET applied_deployment_id = NULL, live_url = NULL, last_error = NULL,
		    reconciled_generation = GREATEST(reconciled_generation, $1)
		WHERE app_id = $2 AND lease_token = $3`, generation, l.AppID, l.Token)
	if err != nil {
		return err
	}
	return requireRow(res, ErrLeaseLost)
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
// that finished after a newer deploy or a Stop. It returns the IDs it
// superseded.
func (s *Store) SweepSuperseded(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		UPDATE deployments d SET status = 'superseded', updated_at = $1
		FROM app_intents i
		WHERE d.app_id = i.app_id
		  AND d.status = 'pending_deployment'
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
