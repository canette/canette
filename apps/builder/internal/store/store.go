// Package store handles all database access for the builder.
// It wraps *sql.DB (pgx/v5) and exposes typed methods.
// Callers never write SQL outside this package.
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
)

// deploymentSnapshot is the parsed content of deployments.deployment_snapshot.
// It is populated by the API at trigger time and contains everything the builder
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
}

// PendingDeployment is a deployment row joined with its app and project.
type PendingDeployment struct {
	ID            string
	CommitSha     string
	AppID         string
	AppSlug       string
	AppPath       string
	SourceType    string // "git" | "image"
	GitURL        string
	GitBranch     string
	GitCredID     *string
	ProjectSlug   string
	CanetteConfig string // snapshotted from apps.canette_config at deployment creation; base layer for the build
}

// GitCredential is a decrypted-ready credential row.
type GitCredential struct {
	ID             string
	Type           string  // "pat" | "ssh_key" | "github_app"
	EncryptedValue *string // AES-256-GCM blob — nil for github_app (unused), caller must decrypt for pat/ssh_key
	SSHKnownHosts  *string // only set for ssh_key type
	InstallationID *string // only set for github_app type (per-team installations)
}

// Store wraps a *sql.DB and exposes builder-specific queries.
type Store struct {
	db                *sql.DB
	log               *zap.Logger
	warnedBadSnapshot sync.Map // deploymentID → struct{}{}, prevents repeated log spam
}

// New creates a Store from an open *sql.DB.
func New(db *sql.DB, log *zap.Logger) *Store {
	return &Store{db: db, log: log}
}

// ClaimPending atomically transitions up to limit deployments from
// pending_build → building and returns them. FOR UPDATE SKIP LOCKED
// ensures multiple builder instances never claim the same row.
// The job name is derived in SQL to match JobName() in the k8s package:
// "can-build-" + first 8 chars of the deployment UUID.
func (s *Store) ClaimPending(ctx context.Context, limit int) ([]PendingDeployment, error) {
	rows, err := s.db.QueryContext(ctx, `
		WITH claimed AS (
			SELECT id FROM deployments
			WHERE status = 'pending_build'
			ORDER BY created_at ASC
			LIMIT $2
			FOR UPDATE SKIP LOCKED
		)
		UPDATE deployments d
		SET status = 'building',
		    build_job_name = 'can-build-' || LEFT(d.id::text, 8),
		    updated_at = $1
		FROM claimed
		WHERE d.id = claimed.id
		RETURNING d.id, d.commit_sha, d.app_id,
		          COALESCE(d.deployment_snapshot, ''),
		          COALESCE(d.canette_config, '')`,
		time.Now().UTC(), limit)
	if err != nil {
		return nil, fmt.Errorf("claim pending: %w", err)
	}
	defer rows.Close()

	var deps []PendingDeployment
	for rows.Next() {
		var d PendingDeployment
		var snapshotJSON string
		if err := rows.Scan(&d.ID, &d.CommitSha, &d.AppID, &snapshotJSON, &d.CanetteConfig); err != nil {
			return nil, fmt.Errorf("scan pending row: %w", err)
		}
		if snapshotJSON == "" {
			if _, alreadyWarned := s.warnedBadSnapshot.LoadOrStore(d.ID, struct{}{}); !alreadyWarned {
				s.log.Warn("pending deployment has no snapshot, skipping", zap.String("deployment_id", d.ID))
			}
			continue
		}
		var snap deploymentSnapshot
		if err := json.Unmarshal([]byte(snapshotJSON), &snap); err != nil {
			if _, alreadyWarned := s.warnedBadSnapshot.LoadOrStore(d.ID, struct{}{}); !alreadyWarned {
				s.log.Warn("pending deployment has unparseable snapshot, skipping",
					zap.String("deployment_id", d.ID), zap.Error(err))
			}
			continue
		}
		d.AppSlug = snap.App.Slug
		d.AppPath = snap.App.AppPath
		d.SourceType = snap.App.SourceType
		d.GitURL = snap.App.GitURL
		d.GitBranch = snap.App.GitBranch
		d.ProjectSlug = snap.Project.Slug
		if snap.App.GitCredentialID != "" {
			credID := snap.App.GitCredentialID
			d.GitCredID = &credID
		}
		deps = append(deps, d)
	}
	return deps, rows.Err()
}

// MarkDeploying transitions building or scanning → pending_deployment and records the image digest.
func (s *Store) MarkDeploying(ctx context.Context, deploymentID, imageDigest string) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		UPDATE deployments
		SET status = 'pending_deployment', image_digest = $1, updated_at = $2
		WHERE id = $3 AND status IN ('building', 'scanning')`,
		imageDigest, now, deploymentID)
	if err != nil {
		return fmt.Errorf("mark deploying: %w", err)
	}
	return nil
}

// MarkFailed transitions any non-terminal status → failed and records the error.
func (s *Store) MarkFailed(ctx context.Context, deploymentID, errMsg string) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		UPDATE deployments
		SET status = 'failed', error_message = $1, updated_at = $2
		WHERE id = $3 AND status NOT IN ('live', 'failed')`,
		errMsg, now, deploymentID)
	if err != nil {
		return fmt.Errorf("mark failed: %w", err)
	}
	return nil
}

// AppendLog inserts a single log line for a deployment.
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

// UpdateCommitSha overwrites the commit_sha on a deployment once the actual
// SHA has been resolved from the git checkout.
func (s *Store) UpdateCommitSha(ctx context.Context, deploymentID, sha string) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE deployments SET commit_sha = $1 WHERE id = $2", sha, deploymentID)
	if err != nil {
		return fmt.Errorf("update commit sha: %w", err)
	}
	return nil
}


// MarkScanning transitions building → scanning and records the scan job name.
func (s *Store) MarkScanning(ctx context.Context, deploymentID, scanJobName string) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		UPDATE deployments
		SET status = 'scanning', build_job_name = $1, updated_at = $2
		WHERE id = $3 AND status = 'building'`,
		scanJobName, now, deploymentID)
	if err != nil {
		return fmt.Errorf("mark scanning: %w", err)
	}
	return nil
}

// SetScanResults stores the scan outcome on the deployment and, if non-empty,
// saves the SBOM JSON into scan_sboms.
func (s *Store) SetScanResults(ctx context.Context, deploymentID, scanStatus, scanSummary, sbom string) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx,
		"UPDATE deployments SET scan_status = $1, scan_summary = $2, updated_at = $3 WHERE id = $4",
		scanStatus, scanSummary, now, deploymentID)
	if err != nil {
		return fmt.Errorf("set scan results: %w", err)
	}
	if sbom != "" {
		_, err = s.db.ExecContext(ctx, `
			INSERT INTO scan_sboms (deployment_id, format, content, created_at)
			VALUES ($1, 'cyclonedx', $2, $3)
			ON CONFLICT (deployment_id) DO UPDATE SET content = excluded.content, created_at = excluded.created_at`,
			deploymentID, sbom, now)
		if err != nil {
			return fmt.Errorf("save sbom: %w", err)
		}
	}
	return nil
}

// SetDeploymentCanetteConfig stores the raw canette.yaml content from the repo
// on the deployment record so the controller can use it at deploy time.
func (s *Store) SetDeploymentCanetteConfig(ctx context.Context, deploymentID, yamlContent string) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE deployments SET canette_config = $1 WHERE id = $2",
		yamlContent, deploymentID)
	if err != nil {
		return fmt.Errorf("set canette config: %w", err)
	}
	return nil
}

// GetGitCredential fetches a git_credential row by ID.
func (s *Store) GetGitCredential(ctx context.Context, id string) (*GitCredential, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, type, encrypted_value, ssh_known_hosts, installation_id
		FROM git_credentials WHERE id = $1`, id)
	var c GitCredential
	if err := row.Scan(&c.ID, &c.Type, &c.EncryptedValue, &c.SSHKnownHosts, &c.InstallationID); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get git credential: %w", err)
	}
	return &c, nil
}
