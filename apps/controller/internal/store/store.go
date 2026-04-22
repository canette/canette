// Package store handles all database access for the controller.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"
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
		GitURL          string `json:"git_url"`
		GitBranch       string `json:"git_branch"`
		AppPath         string `json:"app_path"`
		GitCredentialID string `json:"git_credential_id"`
		Port            int    `json:"port"`
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
	ResourceDefaults struct {
		CPURequest    string `json:"cpu_request"`
		MemoryRequest string `json:"memory_request"`
		CPULimit      string `json:"cpu_limit"`
		MemoryLimit   string `json:"memory_limit"`
	} `json:"resource_defaults"`
}

// DeployingDeployment is the data needed to reconcile one deployment.
type DeployingDeployment struct {
	ID           string
	AppID        string
	AppSlug      string
	ProjectID    string
	ProjectSlug  string
	ProjectOwner string // user ID from projects.created_by (may be empty)
	ImageDigest  string
	CommitSha    string
	SourceType   string // "git" | "image"
	CanetteConfig string // deployments.canette_config — snapshotted from apps at creation, overwritten by builder if repo has canette.yaml
	snapshot     deploymentSnapshot
}

// Resources holds resolved Kubernetes resource requests and limits.
type Resources struct {
	CPURequest    string
	MemoryRequest string
	CPULimit      string
	MemoryLimit   string
}

// AppConfig is the full config for an app needed during reconciliation.
type AppConfig struct {
	AppID        string
	AppSlug      string
	ProjectID    string
	ProjectSlug  string
	ProjectOwner string // user ID from projects.created_by (may be empty)
	ImageDigest  string
	CommitSha    string
	SourceType   string // "git" | "image"
	Port         int
	Replicas     int
	Resources    Resources
	Env          map[string]string
}

// Secret is an encrypted secret row.
type Secret struct {
	Key            string
	EncryptedValue string
}

// Store wraps a *sql.DB and exposes controller-specific queries.
type Store struct {
	db                *sql.DB
	log               *zap.Logger
	warnedBadSnapshot sync.Map // deploymentID → struct{}{}, prevents repeated log spam
}

// New creates a Store from an open *sql.DB.
func New(db *sql.DB, log *zap.Logger) *Store {
	return &Store{db: db, log: log}
}

// StoppedDeployment is the data needed to tear down a stopped app's K8s resources.
type StoppedDeployment struct {
	ID          string
	AppID       string
	AppSlug     string
	ProjectID   string
	ProjectSlug string
}

// ClaimTeardown returns up to limit deployments with status='stopped' that still have
// an applied_manifest (meaning K8s resources were created and need to be deleted).
// App/project slugs are read from deployment_snapshot; no table joins needed.
func (s *Store) ClaimTeardown(ctx context.Context, limit int) ([]StoppedDeployment, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, app_id, COALESCE(deployment_snapshot, '')
		FROM deployments
		WHERE status = 'stopped' AND applied_manifest IS NOT NULL
		ORDER BY updated_at ASC
		LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("query stopped: %w", err)
	}
	defer rows.Close()

	var deps []StoppedDeployment
	for rows.Next() {
		var d StoppedDeployment
		var snapshotJSON string
		if err := rows.Scan(&d.ID, &d.AppID, &snapshotJSON); err != nil {
			return nil, fmt.Errorf("scan stopped row: %w", err)
		}
		if snapshotJSON == "" {
			if _, alreadyWarned := s.warnedBadSnapshot.LoadOrStore(d.ID, struct{}{}); !alreadyWarned {
				s.log.Warn("stopped deployment has no snapshot, skipping teardown", zap.String("deployment_id", d.ID))
			}
			continue
		}
		var snap deploymentSnapshot
		if err := json.Unmarshal([]byte(snapshotJSON), &snap); err != nil {
			if _, alreadyWarned := s.warnedBadSnapshot.LoadOrStore(d.ID, struct{}{}); !alreadyWarned {
				s.log.Warn("stopped deployment has unparseable snapshot, skipping teardown",
					zap.String("deployment_id", d.ID), zap.Error(err))
			}
			continue
		}
		d.AppSlug = snap.App.Slug
		d.ProjectID = snap.Project.ID
		d.ProjectSlug = snap.Project.Slug
		deps = append(deps, d)
	}
	return deps, rows.Err()
}

// MarkTornDown clears applied_manifest on a stopped deployment so ClaimTeardown
// won't pick it up again on the next poll cycle.
func (s *Store) MarkTornDown(ctx context.Context, deploymentID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE deployments SET applied_manifest = NULL WHERE id = $1 AND status = 'stopped'`,
		deploymentID)
	if err != nil {
		return fmt.Errorf("mark torn down: %w", err)
	}
	return nil
}

// ClearAppLiveURL sets apps.live_url = NULL.
func (s *Store) ClearAppLiveURL(ctx context.Context, appID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE apps SET live_url = NULL WHERE id = $1`, appID)
	if err != nil {
		return fmt.Errorf("clear app live url: %w", err)
	}
	return nil
}

// ClaimDeploying atomically transitions up to limit deployments from
// pending_deployment → deploying and returns them. FOR UPDATE SKIP LOCKED
// ensures multiple controller instances never claim the same row.
func (s *Store) ClaimDeploying(ctx context.Context, limit int) ([]DeployingDeployment, error) {
	rows, err := s.db.QueryContext(ctx, `
		UPDATE deployments
		SET status = 'deploying', updated_at = $1
		WHERE id IN (
			SELECT id FROM deployments
			WHERE status = 'pending_deployment'
			ORDER BY created_at ASC
			LIMIT $2
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, app_id, image_digest, commit_sha,
		          COALESCE(deployment_snapshot, ''),
		          COALESCE(canette_config, '')`,
		time.Now().UTC(), limit)
	if err != nil {
		return nil, fmt.Errorf("query deploying: %w", err)
	}
	defer rows.Close()

	var deps []DeployingDeployment
	for rows.Next() {
		var d DeployingDeployment
		var snapshotJSON string
		if err := rows.Scan(&d.ID, &d.AppID, &d.ImageDigest, &d.CommitSha,
			&snapshotJSON, &d.CanetteConfig); err != nil {
			return nil, fmt.Errorf("scan deploying row: %w", err)
		}
		if snapshotJSON == "" {
			if _, alreadyWarned := s.warnedBadSnapshot.LoadOrStore(d.ID, struct{}{}); !alreadyWarned {
				s.log.Warn("pending deployment has no snapshot, skipping", zap.String("deployment_id", d.ID))
			}
			continue
		}
		if err := json.Unmarshal([]byte(snapshotJSON), &d.snapshot); err != nil {
			if _, alreadyWarned := s.warnedBadSnapshot.LoadOrStore(d.ID, struct{}{}); !alreadyWarned {
				s.log.Warn("pending deployment has unparseable snapshot, skipping",
					zap.String("deployment_id", d.ID), zap.Error(err))
			}
			continue
		}
		d.AppSlug = d.snapshot.App.Slug
		d.ProjectID = d.snapshot.Project.ID
		d.ProjectSlug = d.snapshot.Project.Slug
		d.ProjectOwner = d.snapshot.Project.OwnerID
		d.SourceType = d.snapshot.App.SourceType
		deps = append(deps, d)
	}
	return deps, rows.Err()
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
		CPURequest:    pick(cfg.Resources.Requests.CPU, cpuReq),
		MemoryRequest: pick(cfg.Resources.Requests.Memory, memReq),
		CPULimit:      pick(cfg.Resources.Limits.CPU, cpuLim),
		MemoryLimit:   pick(cfg.Resources.Limits.Memory, memLim),
	}

	// Port: snapshot value as base, canette_config runtime.port overrides if set.
	port := snap.App.Port
	if port == 0 {
		port = 3000
	}
	if cfg.Runtime.Port != nil && *cfg.Runtime.Port > 0 {
		port = *cfg.Runtime.Port
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

	return &AppConfig{
		AppID:        dep.AppID,
		AppSlug:      dep.AppSlug,
		ProjectID:    dep.ProjectID,
		ProjectSlug:  dep.ProjectSlug,
		ProjectOwner: dep.ProjectOwner,
		ImageDigest:  dep.ImageDigest,
		CommitSha:    dep.CommitSha,
		SourceType:   dep.SourceType,
		Port:         port,
		Replicas:     replicas,
		Resources:    res,
		Env:          envMap,
	}, parseErr
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

// MarkLive transitions a deployment to status='live'.
func (s *Store) MarkLive(ctx context.Context, deploymentID string) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		UPDATE deployments SET status = 'live', updated_at = $1
		WHERE id = $2 AND status = 'deploying'`, now, deploymentID)
	if err != nil {
		return fmt.Errorf("mark live: %w", err)
	}
	return nil
}

// MarkFailed transitions a deployment to status='failed'.
func (s *Store) MarkFailed(ctx context.Context, deploymentID, errMsg string) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		UPDATE deployments SET status = 'failed', error_message = $1, updated_at = $2
		WHERE id = $3 AND status NOT IN ('live', 'failed')`, errMsg, now, deploymentID)
	if err != nil {
		return fmt.Errorf("mark failed: %w", err)
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

// SetAppLiveURL updates apps.live_url.
func (s *Store) SetAppLiveURL(ctx context.Context, appID, liveURL string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE apps SET live_url = $1 WHERE id = $2`, liveURL, appID)
	if err != nil {
		return fmt.Errorf("set app live url: %w", err)
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

// PendingNamespaceDeletion is a namespace queued for deletion after a project rename.
type PendingNamespaceDeletion struct {
	ID        string
	Namespace string
}

// ClaimNamespaceDeletions returns up to limit namespaces queued for deletion.
func (s *Store) ClaimNamespaceDeletions(ctx context.Context, limit int) ([]PendingNamespaceDeletion, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, namespace FROM pending_namespace_deletions ORDER BY created_at ASC LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("query namespace deletions: %w", err)
	}
	defer rows.Close()

	var dels []PendingNamespaceDeletion
	for rows.Next() {
		var d PendingNamespaceDeletion
		if err := rows.Scan(&d.ID, &d.Namespace); err != nil {
			return nil, fmt.Errorf("scan namespace deletion row: %w", err)
		}
		dels = append(dels, d)
	}
	return dels, rows.Err()
}

// MarkNamespaceDeleted removes a pending namespace deletion record.
func (s *Store) MarkNamespaceDeleted(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM pending_namespace_deletions WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("mark namespace deleted: %w", err)
	}
	return nil
}
