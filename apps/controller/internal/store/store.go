// Package store handles all database access for the controller.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"canette.dev/controller/internal/config"
)

// deploymentSnapshot is the parsed content of deployments.deployment_snapshot.
// It is populated by the API at trigger time and contains everything the controller
// needs without joining other tables.
type deploymentSnapshot struct {
	App struct {
		ID              string `json:"id"`
		Slug            string `json:"slug"`
		SourceType      string `json:"source_type"`
		DeploymentType  string `json:"deployment_type"`
		GitURL          string `json:"git_url"`
		GitBranch       string `json:"git_branch"`
		AppPath         string `json:"app_path"`
		GitCredentialID string `json:"git_credential_id"`
		Port            int    `json:"port"`
		Schedule        string `json:"schedule"`
		PasswordGate    struct {
			Enabled      bool   `json:"enabled"`
			PasswordHash string `json:"password_hash"`
		} `json:"password_gate"`
	} `json:"app"`
	Project struct {
		ID      string `json:"id"`
		Slug    string `json:"slug"`
		OwnerID string `json:"owner_id"`
	} `json:"project"`
	EnvVars []struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	} `json:"env_vars"`
	Volumes []struct {
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Type      string          `json:"type"`
		MountPath string          `json:"mount_path"`
		Config    json.RawMessage `json:"config"`
	} `json:"volumes"`
	ExtraHostnames   []string `json:"extra_hostnames"`
	ResourceDefaults struct {
		CPURequest    string `json:"cpu_request"`
		MemoryRequest string `json:"memory_request"`
		CPULimit      string `json:"cpu_limit"`
		MemoryLimit   string `json:"memory_limit"`
	} `json:"resource_defaults"`
}

// DeployingDeployment is the data needed to reconcile one deployment.
type DeployingDeployment struct {
	ID             string
	AppID          string
	AppSlug        string
	ProjectID      string
	ProjectSlug    string
	ProjectOwner   string // user ID from projects.created_by (may be empty)
	ImageDigest    string
	CommitSha      string
	SourceType     string // "git" | "image"
	DeploymentType string // "web" | "private" | "cronjob"
	CanetteConfig  string // deployments.canette_config — snapshotted from apps at creation, overwritten by builder if repo has canette.yaml
	snapshot       deploymentSnapshot
}

// parseSnapshot fills d's snapshot and the fields taken from it. A deployment
// whose snapshot is missing or unparseable can never be reconciled; the
// returned error says so in words fit for its error_message.
func (d *DeployingDeployment) parseSnapshot(snapshotJSON string) error {
	if snapshotJSON == "" {
		return errors.New("deployment has no snapshot; redeploy to retry")
	}
	if err := json.Unmarshal([]byte(snapshotJSON), &d.snapshot); err != nil {
		return fmt.Errorf("deployment snapshot could not be parsed (%s); redeploy to retry", err)
	}
	d.AppSlug = d.snapshot.App.Slug
	d.ProjectID = d.snapshot.Project.ID
	d.ProjectSlug = d.snapshot.Project.Slug
	d.ProjectOwner = d.snapshot.Project.OwnerID
	d.SourceType = d.snapshot.App.SourceType
	d.DeploymentType = d.snapshot.App.DeploymentType
	if d.DeploymentType == "" {
		d.DeploymentType = "web" // backward compat: snapshots before migration have no field
	}
	return nil
}

// Resources holds resolved Kubernetes resource requests and limits.
type Resources struct {
	CPURequest    string
	MemoryRequest string
	CPULimit      string
	MemoryLimit   string
}

// VolumeConfig holds the parsed config for a single volume.
type VolumeConfig struct {
	Size    string `json:"size"`    // PVC (required) and emptyDir (optional)
	Content string `json:"content"` // configmap only
}

// VolumeSpec describes a volume to mount in the app container.
type VolumeSpec struct {
	ID        string
	Name      string
	Type      string // "pvc" | "emptyDir" | "configmap"
	MountPath string
	Config    VolumeConfig
}

// PasswordGateSpec describes the optional HTTP Basic Auth gate for a web
// app — a single shared password, not individual accounts.
type PasswordGateSpec struct {
	Enabled      bool
	PasswordHash string // bcrypt hash, e.g. "$2b$10$..." — never a plaintext password
}

// Healthcheck describes a resolved readinessProbe, built only when
// canette.yaml's healthcheck block is present — see GetAppConfig.
type Healthcheck struct {
	Path                string
	Port                int
	InitialDelaySeconds int
	PeriodSeconds       int
}

// AppConfig is the full config for an app needed during reconciliation.
type AppConfig struct {
	AppID          string
	AppSlug        string
	ProjectID      string
	ProjectSlug    string
	ProjectOwner   string // user ID from projects.created_by (may be empty)
	ImageDigest    string
	CommitSha      string
	SourceType     string // "git" | "image"
	DeploymentType string // "web" | "private" | "cronjob"
	Schedule       string // cron expression, only set when DeploymentType == "cronjob"
	Command        []string
	Port           int
	Replicas       int
	Resources      Resources
	Env            map[string]string
	Volumes        []VolumeSpec
	ExtraHostnames []string
	PasswordGate   PasswordGateSpec
	Healthcheck    *Healthcheck // nil when canette.yaml has no healthcheck block
	// Security is the resolved canette.yaml hardened mode, nil when off.
	Security *config.Hardening
	// ConfigWarnings are canette.yaml settings that have no effect, for the
	// deployment log.
	ConfigWarnings []string
}

// Secret is an encrypted secret row.
type Secret struct {
	Key            string
	EncryptedValue string
}

// Store wraps a *sql.DB and exposes controller-specific queries.
type Store struct {
	db  *sql.DB
	log *zap.Logger
}

// New creates a Store from an open *sql.DB.
func New(db *sql.DB, log *zap.Logger) *Store {
	return &Store{db: db, log: log}
}

// GetAppConfig builds the full app config for reconciliation.
// Resource defaults, port, and env vars come from the deployment snapshot (captured at
// trigger time). The canette.yaml in the repo (stored in CanetteConfig after the build)
// overrides individual fields when present.
func (s *Store) GetAppConfig(ctx context.Context, dep DeployingDeployment) (*AppConfig, error) {
	snap := dep.snapshot

	cfg, parseErr := config.ParseRuntimeConfig(dep.CanetteConfig)
	if parseErr != nil {
		cfg = config.CanetteRuntimeConfig{} // fall through to snapshot defaults
	}
	// Resolved separately so an invalid security block is reported as a
	// *config.SecurityError (which fails the deployment) even when the rest
	// of the file falls back to defaults.
	security, configWarnings, securityErr := config.ResolveSecurity(dep.CanetteConfig)

	// Resource defaults: snapshot values as base, canette_config YAML overrides if set.
	pick := func(cfgVal, def string) string {
		if cfgVal != "" {
			return cfgVal
		}
		return def
	}
	cpuReq := snap.ResourceDefaults.CPURequest
	if cpuReq == "" {
		cpuReq = "100m"
	}
	memReq := snap.ResourceDefaults.MemoryRequest
	if memReq == "" {
		memReq = "128Mi"
	}
	cpuLim := snap.ResourceDefaults.CPULimit
	if cpuLim == "" {
		cpuLim = "500m"
	}
	memLim := snap.ResourceDefaults.MemoryLimit
	if memLim == "" {
		memLim = "512Mi"
	}
	res := Resources{
		CPURequest:    pick(string(cfg.Resources.Requests.CPU), cpuReq),
		MemoryRequest: pick(string(cfg.Resources.Requests.Memory), memReq),
		CPULimit:      pick(string(cfg.Resources.Limits.CPU), cpuLim),
		MemoryLimit:   pick(string(cfg.Resources.Limits.Memory), memLim),
	}

	// Port: snapshot value as base, canette_config runtime.port overrides if set.
	port := snap.App.Port
	if port == 0 {
		port = 3000
	}
	if cfg.Runtime.Port != nil && *cfg.Runtime.Port > 0 {
		port = *cfg.Runtime.Port
	}

	// Healthcheck: canette.yaml only, no DB/snapshot fallback — absence of the
	// block means no probe is generated at all (matches today's behavior for
	// every app that hasn't opted in).
	var healthcheck *Healthcheck
	if cfg.Healthcheck != nil {
		hc := &Healthcheck{
			Path:                cfg.Healthcheck.Path,
			Port:                port,
			InitialDelaySeconds: 5,
			PeriodSeconds:       10,
		}
		if hc.Path == "" {
			hc.Path = "/"
		}
		if cfg.Healthcheck.Port != nil && *cfg.Healthcheck.Port > 0 {
			hc.Port = *cfg.Healthcheck.Port
		}
		if cfg.Healthcheck.InitialDelay != nil && *cfg.Healthcheck.InitialDelay >= 0 {
			hc.InitialDelaySeconds = *cfg.Healthcheck.InitialDelay
		}
		if cfg.Healthcheck.Period != nil && *cfg.Healthcheck.Period > 0 {
			hc.PeriodSeconds = *cfg.Healthcheck.Period
		}
		healthcheck = hc
	}

	const maxReplicas = 20
	replicas := 1
	if cfg.Replicas != nil && *cfg.Replicas >= 1 {
		replicas = *cfg.Replicas
		if replicas > maxReplicas {
			replicas = maxReplicas
		}
	}

	// Env vars: snapshot env_vars as base, canette_config env section overrides.
	envMap := make(map[string]string, len(snap.EnvVars))
	for _, v := range snap.EnvVars {
		envMap[v.Key] = v.Value
	}
	for k, v := range cfg.Env {
		envMap[k] = v
	}
	// PORT is always injected explicitly from the resolved port above (see
	// resources.go), so strip any user-supplied PORT here — from a DB env var
	// or a committed canette.yaml `env:` section — regardless of how it got
	// into the map. Leaving it in produces two "PORT" entries in the
	// container's env list, which server-side apply rejects outright (the
	// list is keyed by name and must be unique).
	delete(envMap, "PORT")

	volumes := make([]VolumeSpec, 0, len(snap.Volumes))
	for _, v := range snap.Volumes {
		var vcfg VolumeConfig
		if len(v.Config) > 0 {
			_ = json.Unmarshal(v.Config, &vcfg)
		}
		volumes = append(volumes, VolumeSpec{
			ID:        v.ID,
			Name:      v.Name,
			Type:      v.Type,
			MountPath: v.MountPath,
			Config:    vcfg,
		})
	}

	return &AppConfig{
		AppID:          dep.AppID,
		AppSlug:        dep.AppSlug,
		ProjectID:      dep.ProjectID,
		ProjectSlug:    dep.ProjectSlug,
		ProjectOwner:   dep.ProjectOwner,
		ImageDigest:    dep.ImageDigest,
		CommitSha:      dep.CommitSha,
		SourceType:     dep.SourceType,
		DeploymentType: dep.DeploymentType,
		Schedule:       snap.App.Schedule,
		Command:        cfg.Runtime.Command,
		Port:           port,
		Replicas:       replicas,
		Resources:      res,
		Env:            envMap,
		Volumes:        volumes,
		ExtraHostnames: snap.ExtraHostnames,
		// Enabled is additionally guarded on DeploymentType == "web" here as
		// defense-in-depth: if an app's type is later switched away from "web"
		// while gate columns are still set on the row, the controller must never
		// build the sidecar for a non-web app, independent of the API layer.
		PasswordGate: PasswordGateSpec{
			Enabled:      snap.App.PasswordGate.Enabled && dep.DeploymentType == "web",
			PasswordHash: snap.App.PasswordGate.PasswordHash,
		},
		Healthcheck:    healthcheck,
		Security:       security,
		ConfigWarnings: configWarnings,
	}, errors.Join(securityErr, parseErr)
}

// GetSecrets returns all secrets (encrypted) for an app.
func (s *Store) GetSecrets(ctx context.Context, appID string) ([]Secret, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT key, encrypted_value FROM secrets WHERE app_id = $1`, appID)
	if err != nil {
		return nil, fmt.Errorf("query secrets: %w", err)
	}
	defer rows.Close()

	var secrets []Secret
	for rows.Next() {
		var sec Secret
		if err := rows.Scan(&sec.Key, &sec.EncryptedValue); err != nil {
			return nil, fmt.Errorf("scan secret: %w", err)
		}
		secrets = append(secrets, sec)
	}
	return secrets, rows.Err()
}

// CurrentDeployment identifies, for one running app, the deployment whose
// resources the controller last rolled out (app_runtime.applied_deployment_id),
// which the health watcher and the status reader scope their reads to, so a
// leftover pod from a superseded deployment is never mistaken for the
// current one.
type CurrentDeployment struct {
	AppID          string
	AppSlug        string
	ProjectID      string
	ProjectSlug    string
	DeploymentID   string
	DeploymentType string // "web" | "private" | "cronjob", as the applied deployment was rolled out
}

// GetCurrentDeployments returns the applied deployment of every app that
// should be running. Deliberately not the attempt in progress: while a
// redeploy rolls out, the controller's own rollout check (CheckRollout) is the
// authoritative health signal for that window, not the background watcher,
// which could otherwise flag a pod that is legitimately still starting up.
func (s *Store) GetCurrentDeployments(ctx context.Context) ([]CurrentDeployment, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT a.id, a.slug, a.project_id, p.slug, r.applied_deployment_id, a.deployment_type, d.deployment_snapshot
		FROM app_runtime r
		JOIN app_intents i ON i.app_id = r.app_id
		JOIN apps a ON a.id = r.app_id
		JOIN projects p ON p.id = a.project_id
		LEFT JOIN deployments d ON d.id = r.applied_deployment_id
		WHERE r.applied_deployment_id IS NOT NULL AND i.desired_state = 'running'
		ORDER BY a.id`)
	if err != nil {
		return nil, fmt.Errorf("query current deployments: %w", err)
	}
	defer rows.Close()

	var out []CurrentDeployment
	for rows.Next() {
		var cd CurrentDeployment
		var appType string
		var snapshotJSON sql.NullString
		if err := rows.Scan(&cd.AppID, &cd.AppSlug, &cd.ProjectID, &cd.ProjectSlug, &cd.DeploymentID, &appType, &snapshotJSON); err != nil {
			return nil, fmt.Errorf("scan current deployment: %w", err)
		}
		cd.DeploymentType = appliedDeploymentType(snapshotJSON.String, appType)
		out = append(out, cd)
	}
	return out, rows.Err()
}

// appliedDeploymentType returns the workload type the applied deployment was
// rolled out as, from its snapshot. The app's current deployment_type can
// differ until the next deploy (a web app edited to cronjob still runs a
// Deployment), so it is only the fallback for a snapshot that can't be read.
func appliedDeploymentType(snapshotJSON, appType string) string {
	var d DeployingDeployment
	if err := d.parseSnapshot(snapshotJSON); err != nil {
		return appType
	}
	return d.DeploymentType
}

// UpdateRuntimeHealth records the health watcher's current verdict for an
// app's live pod(s) — independent of deployments.status, which only ever
// records whether the deploy operation itself succeeded — in
// app_observed_status, creating the app's row on first use like
// UpdateKubernetesStatus. runtime_health_updated_at is when the verdict was
// last confirmed: the watcher also rewrites an unchanged verdict
// periodically. An app deleted since it was read gets nothing written.
func (s *Store) UpdateRuntimeHealth(ctx context.Context, appID, health, reason string) error {
	var reasonArg interface{}
	if reason != "" {
		reasonArg = reason
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO app_observed_status (app_id, runtime_health, runtime_health_reason, runtime_health_updated_at)
		SELECT id, $1, $2, $3 FROM apps WHERE id = $4
		ON CONFLICT (app_id) DO UPDATE
		SET runtime_health = excluded.runtime_health,
			runtime_health_reason = excluded.runtime_health_reason,
			runtime_health_updated_at = excluded.runtime_health_updated_at`,
		health, reasonArg, time.Now().UTC(), appID)
	if err != nil {
		return fmt.Errorf("update runtime health: %w", err)
	}
	return nil
}

// UpdateKubernetesStatus records what Kubernetes reports for an app's
// workload object (Deployment capacity or CronJob state), as JSON, in
// app_observed_status: a table only the controller writes, so it creates the
// app's row on first use. kubernetes_status_observed_at is when it was last
// read: the status reader also rewrites an unchanged status periodically,
// like UpdateRuntimeHealth. An app deleted since it was read has no apps row
// to reference, so nothing is written.
func (s *Store) UpdateKubernetesStatus(ctx context.Context, appID, statusJSON string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO app_observed_status (app_id, kubernetes_status, kubernetes_status_observed_at)
		SELECT id, $1, $2 FROM apps WHERE id = $3
		ON CONFLICT (app_id) DO UPDATE
		SET kubernetes_status = excluded.kubernetes_status,
			kubernetes_status_observed_at = excluded.kubernetes_status_observed_at`,
		statusJSON, time.Now().UTC(), appID)
	if err != nil {
		return fmt.Errorf("update kubernetes status: %w", err)
	}
	return nil
}

// Workload identifies the Deployment or CronJob the controller applied for a
// deployment (#332): its UID, the metadata.generation the apply wrote, and for
// a Deployment the revision its rollout reached. Empty fields are unknown and
// stored as NULL.
type Workload struct {
	UID        string
	Generation int64
	Revision   string
}

func (w Workload) uid() sql.NullString { return sql.NullString{String: w.UID, Valid: w.UID != ""} }
func (w Workload) revision() sql.NullString {
	return sql.NullString{String: w.Revision, Valid: w.Revision != ""}
}
func (w Workload) generation() sql.NullInt64 {
	return sql.NullInt64{Int64: w.Generation, Valid: w.Generation != 0}
}

// SetAppliedWorkload records on the deployment the workload its apply wrote,
// before the rollout is checked, so a failed attempt keeps it too.
func (s *Store) SetAppliedWorkload(ctx context.Context, deploymentID string, w Workload) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE deployments SET workload_uid = $1, workload_generation = $2, workload_revision = $3
		WHERE id = $4`, w.uid(), w.generation(), w.revision(), deploymentID)
	if err != nil {
		return fmt.Errorf("set applied workload: %w", err)
	}
	return nil
}

// SetAppliedManifest stores the redacted YAML manifest on the deployment.
func (s *Store) SetAppliedManifest(ctx context.Context, deploymentID, manifest string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE deployments SET applied_manifest = $1 WHERE id = $2`, manifest, deploymentID)
	if err != nil {
		return fmt.Errorf("set applied manifest: %w", err)
	}
	return nil
}

// AppendLog inserts a single log line for a deployment (reuses build_logs table).
func (s *Store) AppendLog(ctx context.Context, deploymentID, stream, line string) error {
	id := uuid.New().String()
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO build_logs (id, deployment_id, stream, line, created_at)
		VALUES ($1, $2, $3, $4, $5)`,
		id, deploymentID, stream, line, now)
	if err != nil {
		return fmt.Errorf("append log: %w", err)
	}
	return nil
}

// PendingNamespaceDeletion holds the project coordinates for a namespace queued for cleanup.
type PendingNamespaceDeletion struct {
	ID          string
	ProjectID   string
	ProjectSlug string
	// ProjectExists is true when the project row is still there, i.e. the
	// namespace was queued by a slug rename rather than a project/team delete.
	ProjectExists bool
	// BlockedReason is why the last attempt kept the namespace, empty if it
	// was never blocked.
	BlockedReason string
	// DeleteRequested is true once an earlier attempt sent the namespace's
	// delete (MarkNamespaceDeleteRequested). It may be terminating, or
	// Kubernetes may have refused the delete.
	DeleteRequested bool
	// ClaimToken names this claim. Finishing it (MarkNamespaceDeleted,
	// MarkNamespaceBlocked, ReleaseNamespaceDeletion) needs it, so a worker
	// whose claim expired can't touch the claim of the one that took over.
	ClaimToken string
}

// ClaimNamespaceDeletions claims up to limit entries queued for namespace
// cleanup, skipping blocked ones that are not due for another attempt yet,
// with the claim/TTL semantics of ClaimVolumeDeletions. A claimed entry can't
// be un-queued by a project rename back to its slug (updateProject in the
// API refuses the rename instead), so the namespace being deleted never
// becomes the live one again. Finish with MarkNamespaceDeleted,
// MarkNamespaceBlocked or ReleaseNamespaceDeletion.
func (s *Store) ClaimNamespaceDeletions(ctx context.Context, limit int) ([]PendingNamespaceDeletion, error) {
	now := time.Now().UTC()
	rows, err := s.db.QueryContext(ctx, `
		UPDATE queued_namespace_cleanups q
		SET claimed_at = $1, claim_token = $4
		WHERE q.id IN (
			SELECT id FROM queued_namespace_cleanups
			WHERE (next_attempt_at IS NULL OR next_attempt_at <= $1)
			  AND (claimed_at IS NULL OR claimed_at < $2)
			ORDER BY created_at ASC
			LIMIT $3
			FOR UPDATE SKIP LOCKED
		)
		RETURNING q.id, q.project_id, q.project_slug,
		          EXISTS (SELECT 1 FROM projects p WHERE p.id = q.project_id),
		          COALESCE(q.blocked_reason, ''), q.claim_token, q.delete_requested_at IS NOT NULL`,
		now, now.Add(-volumeDeletionClaimTTL), limit, uuid.NewString())
	if err != nil {
		return nil, fmt.Errorf("query namespace deletions: %w", err)
	}
	defer rows.Close()

	var dels []PendingNamespaceDeletion
	for rows.Next() {
		var d PendingNamespaceDeletion
		if err := rows.Scan(&d.ID, &d.ProjectID, &d.ProjectSlug, &d.ProjectExists, &d.BlockedReason, &d.ClaimToken, &d.DeleteRequested); err != nil {
			return nil, fmt.Errorf("scan namespace deletion row: %w", err)
		}
		dels = append(dels, d)
	}
	return dels, rows.Err()
}

// MarkNamespaceBlocked keeps a queued namespace cleanup, unclaimed, and
// defers its next attempt until retryAt. The namespace is active, not
// terminating, and was left alone, so a rename back to its slug may take it
// over meanwhile: an earlier delete request was refused, so it no longer
// blocks the rename.
func (s *Store) MarkNamespaceBlocked(ctx context.Context, d PendingNamespaceDeletion, reason string, retryAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE queued_namespace_cleanups
		SET blocked_reason = $1, next_attempt_at = $2, claimed_at = NULL, claim_token = NULL,
		    delete_requested_at = NULL
		WHERE id = $3 AND claim_token = $4`,
		reason, retryAt.UTC(), d.ID, d.ClaimToken)
	if err != nil {
		return fmt.Errorf("mark namespace blocked: %w", err)
	}
	return nil
}

// MarkNamespaceDeleteRequested keeps a queued namespace cleanup whose delete
// was sent, even a failed one, while the namespace may be terminating, and
// defers its next check until retryAt (#333). The claim is given up, but
// delete_requested_at keeps refusing a project rename back to the slug
// (updateProject in the API) until MarkNamespaceDeleted.
func (s *Store) MarkNamespaceDeleteRequested(ctx context.Context, d PendingNamespaceDeletion, retryAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE queued_namespace_cleanups
		SET delete_requested_at = COALESCE(delete_requested_at, $1), next_attempt_at = $2,
		    claimed_at = NULL, claim_token = NULL
		WHERE id = $3 AND claim_token = $4`,
		time.Now().UTC(), retryAt.UTC(), d.ID, d.ClaimToken)
	if err != nil {
		return fmt.Errorf("mark namespace delete requested: %w", err)
	}
	return nil
}

// ReleaseNamespaceDeletion gives up the claim on a queued namespace cleanup
// whose attempt failed before the namespace delete was requested, so the
// next poll retries it. After a delete request, even a failed one, use
// MarkNamespaceDeleteRequested: Kubernetes may have started deleting the
// namespace.
func (s *Store) ReleaseNamespaceDeletion(ctx context.Context, d PendingNamespaceDeletion) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE queued_namespace_cleanups SET claimed_at = NULL, claim_token = NULL
		WHERE id = $1 AND claim_token = $2`, d.ID, d.ClaimToken)
	if err != nil {
		return fmt.Errorf("release namespace deletion: %w", err)
	}
	return nil
}

// MarkNamespaceDeleted removes a queued namespace cleanup record once the
// namespace is gone, if this worker's claim on it still holds.
func (s *Store) MarkNamespaceDeleted(ctx context.Context, d PendingNamespaceDeletion) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM queued_namespace_cleanups WHERE id = $1 AND claim_token = $2`, d.ID, d.ClaimToken)
	if err != nil {
		return fmt.Errorf("mark namespace deleted: %w", err)
	}
	return nil
}

// PendingAppCleanup holds the domain identifiers of a deleted app whose K8s
// resources still have to be removed. The controller resolves them to a
// namespace and resource names via packages/golib/k8s.
type PendingAppCleanup struct {
	ID          string
	ProjectID   string
	ProjectSlug string
	AppSlug     string
	// AppID is the deleted app's id, empty for a cleanup queued before
	// migration 000032.
	AppID string
	// PendingReason is what the last attempt was still waiting for, empty
	// if there was no earlier attempt.
	PendingReason string
	// ClaimToken names this claim, as on PendingNamespaceDeletion.
	ClaimToken string
}

// ClaimAppCleanups claims up to limit queued app cleanups, with the same
// claim/TTL semantics as ClaimVolumeDeletions, skipping ones that are not
// due for another attempt yet. Call MarkAppCleanedUp once every resource is
// gone, or MarkAppCleanupPending while some are terminating. On failure the
// claim expires and a later poll retries.
func (s *Store) ClaimAppCleanups(ctx context.Context, limit int) ([]PendingAppCleanup, error) {
	now := time.Now().UTC()
	staleBefore := now.Add(-volumeDeletionClaimTTL)
	rows, err := s.db.QueryContext(ctx, `
		UPDATE queued_app_cleanups
		SET claimed_at = $1, claim_token = $4
		WHERE id IN (
			SELECT id FROM queued_app_cleanups
			WHERE (next_attempt_at IS NULL OR next_attempt_at <= $1)
			  AND (claimed_at IS NULL OR claimed_at < $2)
			ORDER BY created_at ASC
			LIMIT $3
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, project_id, project_slug, app_slug, COALESCE(app_id, ''),
		          COALESCE(pending_reason, ''), claim_token`,
		now, staleBefore, limit, uuid.NewString())
	if err != nil {
		return nil, fmt.Errorf("query app cleanups: %w", err)
	}
	defer rows.Close()

	var cleanups []PendingAppCleanup
	for rows.Next() {
		var c PendingAppCleanup
		if err := rows.Scan(&c.ID, &c.ProjectID, &c.ProjectSlug, &c.AppSlug, &c.AppID, &c.PendingReason, &c.ClaimToken); err != nil {
			return nil, fmt.Errorf("scan app cleanup row: %w", err)
		}
		cleanups = append(cleanups, c)
	}
	return cleanups, rows.Err()
}

// MarkAppCleanupPending keeps a queued app cleanup whose objects are still
// terminating, unclaimed, records what it waits for in reason (createApp
// shows it while the slug is reserved), and defers its next attempt until
// retryAt.
func (s *Store) MarkAppCleanupPending(ctx context.Context, c PendingAppCleanup, reason string, retryAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE queued_app_cleanups
		SET pending_reason = $1, next_attempt_at = $2, claimed_at = NULL, claim_token = NULL
		WHERE id = $3 AND claim_token = $4`,
		reason, retryAt.UTC(), c.ID, c.ClaimToken)
	if err != nil {
		return fmt.Errorf("mark app cleanup pending: %w", err)
	}
	return nil
}

// MarkAppCleanedUp removes a queued app cleanup once every object of the app
// is gone, if this worker's claim on it still holds. That frees the app slug
// for reuse in the project.
func (s *Store) MarkAppCleanedUp(ctx context.Context, c PendingAppCleanup) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM queued_app_cleanups WHERE id = $1 AND claim_token = $2`, c.ID, c.ClaimToken)
	if err != nil {
		return fmt.Errorf("mark app cleaned up: %w", err)
	}
	return nil
}

// PendingVolumeDeletion holds the domain identifiers of a volume whose K8s
// resource is queued for deletion. The controller resolves them to a namespace
// and resource name via packages/golib/k8s.
//
// Rows queued before migration 000018 carry the already-resolved Legacy*
// fields instead (and empty domain fields).
type PendingVolumeDeletion struct {
	ID          string
	ProjectID   string
	ProjectSlug string
	AppSlug     string
	VolumeName  string
	VolumeType  string // "pvc" | "configmap"
	// VolumeID is the removed volume's id, empty for rows queued before
	// migration 000032.
	VolumeID string
	// ClaimToken names this claim, as on PendingNamespaceDeletion.
	ClaimToken string

	LegacyNamespace    string
	LegacyResourceType string // "PersistentVolumeClaim" | "ConfigMap"
	LegacyResourceName string
}

// volumeDeletionClaimTTL bounds how long a claimed row stays "in flight" before
// another controller may retry it. Long enough to absorb a slow K8s API call,
// short enough that a crashed controller's claims become available again.
const volumeDeletionClaimTTL = 5 * time.Minute

// CleanupClaimTTL is how long a claim on a queued namespace, app or volume
// cleanup lasts. The worker must be done well within it, so it never acts
// on a row another worker has taken over.
const CleanupClaimTTL = volumeDeletionClaimTTL

// ClaimVolumeDeletions atomically transitions up to limit rows from "unclaimed"
// (or "claimed long ago") to "claimed now" and returns them, skipping ones
// that are not due for another attempt yet. Uses FOR UPDATE SKIP LOCKED so
// multiple controller replicas never claim the same row. Call
// MarkVolumeDeleted once the object is gone, or MarkVolumeDeletionPending
// while it terminates. On failure the claim expires after
// volumeDeletionClaimTTL and another poll cycle retries.
func (s *Store) ClaimVolumeDeletions(ctx context.Context, limit int) ([]PendingVolumeDeletion, error) {
	now := time.Now().UTC()
	staleBefore := now.Add(-volumeDeletionClaimTTL)
	rows, err := s.db.QueryContext(ctx, `
		UPDATE pending_volume_deletions
		SET claimed_at = $1, claim_token = $4
		WHERE id IN (
			SELECT id FROM pending_volume_deletions
			WHERE (next_attempt_at IS NULL OR next_attempt_at <= $1)
			  AND (claimed_at IS NULL OR claimed_at < $2)
			ORDER BY created_at ASC
			LIMIT $3
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id,
			COALESCE(project_id, ''), COALESCE(project_slug, ''), COALESCE(app_slug, ''),
			COALESCE(volume_name, ''), COALESCE(volume_type, ''), COALESCE(volume_id, ''),
			COALESCE(namespace, ''), COALESCE(resource_type, ''), COALESCE(resource_name, ''),
			claim_token`,
		now, staleBefore, limit, uuid.NewString())
	if err != nil {
		return nil, fmt.Errorf("query volume deletions: %w", err)
	}
	defer rows.Close()

	var dels []PendingVolumeDeletion
	for rows.Next() {
		var d PendingVolumeDeletion
		if err := rows.Scan(&d.ID,
			&d.ProjectID, &d.ProjectSlug, &d.AppSlug, &d.VolumeName, &d.VolumeType, &d.VolumeID,
			&d.LegacyNamespace, &d.LegacyResourceType, &d.LegacyResourceName, &d.ClaimToken); err != nil {
			return nil, fmt.Errorf("scan volume deletion row: %w", err)
		}
		dels = append(dels, d)
	}
	return dels, rows.Err()
}

// MarkVolumeDeletionPending keeps a pending volume deletion whose object is
// still terminating, unclaimed, and defers its next attempt until retryAt.
// While the row stays, createVolume gives a new volume with the same name a
// suffixed one.
func (s *Store) MarkVolumeDeletionPending(ctx context.Context, d PendingVolumeDeletion, retryAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE pending_volume_deletions
		SET next_attempt_at = $1, claimed_at = NULL, claim_token = NULL
		WHERE id = $2 AND claim_token = $3`,
		retryAt.UTC(), d.ID, d.ClaimToken)
	if err != nil {
		return fmt.Errorf("mark volume deletion pending: %w", err)
	}
	return nil
}

// MarkVolumeDeleted removes a pending volume deletion record once the object
// is gone, if this worker's claim on it still holds.
func (s *Store) MarkVolumeDeleted(ctx context.Context, d PendingVolumeDeletion) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM pending_volume_deletions WHERE id = $1 AND claim_token = $2`, d.ID, d.ClaimToken)
	if err != nil {
		return fmt.Errorf("mark volume deleted: %w", err)
	}
	return nil
}
