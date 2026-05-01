# CLAUDE.md

This file provides context for AI-assisted development on canette. Read this before touching any part of the codebase.

---

## What is canette?

canette (Kubernetes Push-to-deploy Platform) is a lightweight internal PaaS that runs inside an existing Kubernetes cluster. It gives developers a Vercel-like push-to-deploy experience without requiring external services or platform expertise.

The core user is a developer or designer who wants to host a demo, Storybook, or small internal service. They should be able to go from a Git repo to a live URL in under 2 minutes, with no Dockerfile and no Kubernetes knowledge.

---

## Monorepo structure

```
canette/
├── apps/
│   ├── ui/          # Next.js 16 web UI (TypeScript)
│   ├── api/         # Bun + Hono REST API server (TypeScript)
│   ├── docs/        # Docusaurus documentation site (TypeScript/MDX)
│   ├── controller/  # K8s reconciliation controller (Go)
│   ├── builder/     # Build job manager (Go)
│   └── logstreamer/ # Live pod log streaming service (Go)
├── charts/
│   └── canette/     # Helm chart (all services in one chart)
├── packages/
│   └── types/       # Shared TypeScript types (api ↔ ui)
├── labs/            # Manual test YAMLs (not shipped)
└── CLAUDE.md
```

---

## Architecture decisions — read these before proposing changes

### Language split
- **TypeScript (Bun)** for `api` and `ui`. These are user-facing, iterate fast, web idioms apply.
- **Go** for `controller` and `builder`. These talk directly to the Kubernetes API via `client-go`. Do not introduce TypeScript in these packages. Do not introduce Go in the TypeScript packages.

### The controller is a reconciliation loop, not a job runner
The controller reads desired state from the database and reconciles it with the cluster. It does not respond to webhooks directly. The API server handles webhooks, writes desired state to the database, and the controller picks it up. This is the Kubernetes operator pattern — respect it.

### Gateway API only — no legacy Ingress
canette generates `HTTPRoute` and `Gateway` resources. Never generate `networking.k8s.io/v1 Ingress` resources. The `gatewayClassName` comes from Helm values and is the only place implementation-specific knowledge lives.

### Database
PostgreSQL via the `pg` npm package (TypeScript) and `jackc/pgx/v5` (Go). Never modify the schema without a migration file.

**Migration files** live in `apps/api/migrations/` as plain SQL — one `{version}_{description}.up.sql` and one `.down.sql` per migration. The version prefix is a zero-padded number (e.g. `000001`). Always use `CURRENT_TIMESTAMP` instead of `NOW()` — it works on both PostgreSQL and SQLite (used in tests).

**Migration runner** (`apps/api/src/db/migrations.ts`) accepts any Kysely `DB` instance, reads the `.up.sql` files in order, splits each file on `;` and executes statements one at a time, and tracks applied versions in a `schema_migrations` table. The runner is invoked at API startup via `apps/api/scripts/migrate.ts`, which reads `MIGRATIONS_DIR` from the environment (defaults to `./migrations` relative to cwd — matches the directory next to the compiled binary).

Local dev: deploy an in-cluster PostgreSQL instance with `kubectl apply -f labs/postgres.yaml`, then port-forward it with `kubectl port-forward -n canette-system svc/postgres 5432:5432`. Set `DATABASE_URL=postgresql://canette:canette@localhost:5432/canette` in `apps/api/.env`. Run `bun run --cwd apps/api db:migrate` to apply all pending migrations.

### Secrets
App secrets (env vars) are encrypted at rest with AES-256-GCM. The master key comes from a Kubernetes Secret created at Helm install time. The API server decrypts values at deploy time and creates Kubernetes Secrets in the app's namespace. Secret values are never logged, never returned by the API after being set, and never stored in plaintext.

### Build jobs
Each build runs as a Kubernetes Job in the `canette-system` namespace. The job has two stages:
1. `git-clone` — init container, shallow clone at the exact commit SHA into a shared `emptyDir` volume
2. `image-build` — main container, runs the `canette-build` binary which calls railpack to auto-detect the project type, generate a build plan, and build + push the image via BuildKit

Railpack is the BuildKit frontend — it replaces both nixpacks (Dockerfile generation) and kaniko (image building) in a single tool. Do not use nixpacks or kaniko.

Build jobs run rootless via BuildKit's rootless mode:
- `securityContext.seccompProfile.type: RuntimeDefault` on the build pod
- `BUILDKITD_FLAGS: --oci-worker-no-process-sandbox` set on the buildkitd sidecar or embedded daemon
- BuildKit state mounted as an `emptyDir` at `/home/user/.local/share/buildkit`
- Nodes must run kernel >= 4.18; kernel >= 5.11 is preferred for native overlayfs (falls back to fuse-overlayfs otherwise)
- Network mode inside builds is always host — this is a rootless BuildKit limitation, not configurable

Build jobs must never run as root. During tests, railpack/BuildKit runs with `--output type=image,push=false` (no registry push). The `nodeSelector` and `tolerations` for build jobs come from Helm values — never hardcode them.

### Deployment snapshot — self-contained deployment rows

Each deployment row carries a `deployment_snapshot` JSON column written by the API at trigger time. It contains everything the Go services need to process a deployment without joining other tables:

```json
{
  "app":  { "id", "slug", "source_type", "git_url", "git_branch", "app_path", "git_credential_id", "port" },
  "project": { "id", "slug", "owner_id" },
  "env_vars": [ { "key": "...", "value": "..." } ],
  "resource_defaults": { "cpu_request", "memory_request", "cpu_limit", "memory_limit" },
  "scan_policy": { "scan_enabled", "scan_mandatory", "fail_severity" }
}
```

**Why**: The builder and controller previously joined `apps`, `projects`, `env_vars`, `admin_settings`, and `git_credentials` on every poll cycle. The snapshot eliminates those reads. Only two live reads remain:
- **Builder** → `git_credentials` (encrypted PAT/SSH key, read by FK from snapshot)
- **Controller** → `secrets` (encrypted app secrets, read by `app_id`)

**Merge semantics for runtime config**: `deployments.canette_config` holds the user's raw `apps.canette_config` YAML (snapshotted at trigger time). The controller's `GetAppConfig()` merges them: snapshot values (port, resource defaults, env vars) serve as the base; fields present in `canette_config` YAML win. If the repo contains a `canette.yaml`, the builder overwrites `deployments.canette_config` with it after the build — repo fields win over everything else.

**Staleness is intentional**: env vars, port, and admin settings are captured at trigger time. Changes after triggering take effect on the next deployment.

### Auth
Auth is handled by `better-auth` embedded in the API server. Supported providers: Google OAuth, GitHub OAuth, email magic link (requires SMTP config). Do not add Keycloak, Dex, or any external auth service as a dependency.

---

## Component responsibilities

### `apps/api` (TypeScript · Bun · Hono)
- All REST endpoints under `/api/v1`
- Webhook receiver for GitHub, GitLab, Gitea (HMAC validation required)
- Secret encryption/decryption
- Auth middleware (better-auth sessions)
- Writes desired state to the database
- Does NOT talk to the Kubernetes API directly (that's the controller's job)

### `apps/ui` (TypeScript · Next.js 16)
- Talks only to `apps/api` — never directly to Kubernetes
- Server components for data fetching, client components for interactivity
- Real-time log streaming via SSE from the API
- No direct database access
- Styling: **Tailwind CSS v4** (CSS-first config via `@import "tailwindcss"` in `globals.css`) + **Radix UI primitives** (components live in `src/components/ui/`) + **Geist** font (via the `geist` npm package)
- **Always use Radix UI primitives** for interactive components where a primitive exists (dropdown menus, dialogs, collapsibles, checkboxes, separators, etc.). Do not re-implement these with manual state + DOM event listeners — Radix handles accessibility, keyboard navigation, and focus management. Installed primitives: `@radix-ui/react-dialog`, `@radix-ui/react-separator`, `@radix-ui/react-slot`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-collapsible`, `@radix-ui/react-checkbox`, `@radix-ui/react-select`, `@radix-ui/react-tabs`. UI components: `select.tsx`, `textarea.tsx` (matches `Input` styling, use for multi-line fields), `tabs.tsx` (use for tabbed views — never use native `<select>` or `<input type="radio">` for tab-like switching), `form-error.tsx` (use for inline form/action error messages — icon + subtle red background). When adding new interactive components, check for a Radix primitive first and install it if available.

### `apps/controller` (Go)
- Watches the database for pending deployments (polling or notify)
- Creates and updates Kubernetes resources: `Namespace`, `Deployment`, `Service`, `HTTPRoute`, `Secret` — references a pre-existing `Gateway` (configured via Helm values `controller.gateway.name` / `controller.gateway.namespace`)
- Uses server-side apply for all resource writes
- Writes deployment status back to the database
- Never handles HTTP requests from external clients

### `apps/builder` (Go)
- Creates Kubernetes `Job` resources for each build (git-clone init container + railpack main container)
- Monitors Job completion via the K8s watch API
- Writes image digest back to the database on success
- Writes error details on failure
- Handles build log streaming (tails pod logs, writes to database)

### `apps/logstreamer` (Go)
- Streams live pod logs to the browser over SSE
- The API proxies `GET /api/v1/apps/:id/logs/stream` to it — the logstreamer is never exposed directly
- On connection: polls for a `Running` pod with label `canette.dev/app=<appSlug>`, opens a following log stream, emits `event: log` SSE frames and `event: ping` keep-alives every 3 s
- Logs are never stored — pure live stream, no database involvement
- Authenticated via a shared secret (`LOGSTREAMER_SECRET`) passed as `Authorization: Bearer` — must match the value configured in the API
- Restricted to in-cluster traffic only via NetworkPolicy (only the API pod may reach port 8080)

---

## Database schema (current)

Tables: `projects`, `apps`, `deployments`, `build_logs`, `secrets`, `env_vars`, `memberships`, `git_credentials`, `webhook_secrets`, `admin_settings`, `scan_sboms`, `pending_namespace_deletions`. Better-auth owns `user`, `session`, `account`, `verification` (note: `user` not `users`).

`git_credentials` columns: `id`, `user_id` (FK → user, nullable for system credentials), `name`, `provider` enum(`github|gitlab|gitea|generic`), `type` enum(`pat|ssh_key|github_app`), `encrypted_value` (AES-256-GCM — stores the PAT token, SSH private key, or GitHub App private key), `created_at`. The `known_hosts` value for SSH credentials is not secret and is stored as plain text in a separate `ssh_known_hosts` column. Credentials are scoped to a user; apps reference them via `apps.git_credential_id`.

Key invariants:
- `projects.slug` — globally unique, lowercase alphanumeric + hyphens, max 50 chars. Used as part of the K8s namespace: `can-{id[:7]}-{slug}`. Immutable after creation (changing it would orphan all K8s resources).
- `apps.slug` — unique within the project, lowercase alphanumeric + hyphens, max 63 chars. Used as the K8s container/resource name.
- `apps.project_id` references `projects.id` — deleting a project cascades to apps
- `deployments.status` is an enum: `pending_build | building | scanning | pending_deployment | deploying | live | failed | stopped`
- `secrets.encrypted_value` is never null — empty string is stored encrypted
- `users.role` is `admin | developer`

Migration files live in `apps/api/migrations/` — this is the single canonical location. The API runs them at startup. Always use the format: `{version}_{description}.up.sql` and `{version}_{description}.down.sql`. Do not create migration files anywhere else in the repo.

---

## canette.yaml schema

The config file that can be committed to a repo. All fields are optional — absence means "use platform defaults".

```yaml
build:
  context: .            # path relative to app root
  dockerfile: Dockerfile
  args:
    KEY: value

runtime:
  port: 3000
  command: ["node", "server.js"]

env:
  KEY: value            # plaintext, safe to commit

secrets:
  - SECRET_NAME         # names only, values set in UI

resources:
  requests:
    cpu: "100m"
    memory: "128Mi"
  limits:
    cpu: "500m"
    memory: "512Mi"

replicas: 1

healthcheck:
  path: /healthz
  port: 3000
  initial_delay: 10
  period: 15

ingress:
  enabled: true
  host: my-app.apps.company.com
  path: /
```

When parsing `canette.yaml`, unknown fields must be silently ignored (forward compatibility). Validation errors must return a clear human-readable message — never a raw Go/JS error.

### canette.yaml field ownership

Fields are split between the database (set via UI) and `canette.yaml` (committed to the repo):

| Field | Owned by | Notes |
|-------|----------|-------|
| `build.context`, `build.dockerfile`, `build.args` | `canette.yaml` only | Parsed at build time from the cloned workspace by the `canette-config` binary |
| `runtime.port`, `runtime.command`, `replicas`, `resources`, `healthcheck` | DB (UI) as base, `canette.yaml` overrides at deploy time | File wins when present; DB value is the fallback |
| `env` | `canette.yaml` only | Plaintext vars safe to commit; merged on top of any DB-stored env vars at deploy time |
| `secrets` | DB only (values); `canette.yaml` can list names | Secret values are never in the file; names in the file are informational. This feature is only useful if we introduce project wide secrets |
| `ingress.enabled`, `ingress.host`, `ingress.path` | DB (UI) as base, `canette.yaml` overrides at deploy time | `ingress.enabled = false` still creates a service, but no httproute. Useful for eg. databases |

**Merge happens at deploy time, not on UI interaction.** The UI always reads and writes DB values. The controller reads `canette.yaml` from the build workspace (via the `canette-config` binary output stored in the deployment record) and applies overrides when constructing K8s resources. The UI may show a note that certain fields could be overridden by `canette.yaml`.

### canette-template.yaml

At a later point we might want to add an extended version of the canette.yaml file used for configuration templates.
This would include git-repo/image and suggested app name. The name is an array with remaning values under it.

A file like this would be loaded into a project in the UI and converted into DB configuration with the help of a wizard.

---

## REST API conventions

- All endpoints under `/api/v1`
- JSON request and response bodies
- Auth: session cookie (UI) or `Authorization: Bearer <token>` (CI/CD)
- Errors return `{ "error": "human readable message", "code": "MACHINE_CODE" }`
- 401 for unauthenticated, 403 for authorised but forbidden, 404 for not found
- Paginated lists return `{ "items": [], "total": n, "page": n, "pageSize": n }`

---

## Helm chart conventions

- All canette-managed resources carry the label `app.kubernetes.io/managed-by: canette`
- App resources in user namespaces also carry `canette.dev/project: <project-name>` and `canette.dev/app: <app-name>`
- ServiceAccounts include IRSA annotation support via `serviceAccount.annotations` in values
- Traefik and cert-manager are **not** bundled as subcharts — they must be pre-installed in the cluster. canette requires a Gateway API implementation (Traefik, Cilium, etc.) to be present before installing the Helm chart.

---

## What to build first (POC order)

1. **Database schema + migrations** — foundation everything else depends on
2. **API server skeleton** — Hono app, auth, project/app CRUD endpoints, no K8s yet
3. **UI skeleton** — Next.js app, auth flow, project/app list and create screens
4. **Builder** — Go service that creates a railpack/BuildKit Job and tails its logs (can be tested standalone with a hardcoded image)
5. **Controller** — Go service that takes a completed build (known image digest) and applies K8s manifests
6. **Webhook receiver** — wire git push → build → deploy end-to-end
7. **Helm chart** — package everything, test on a real cluster

Each of these can be built and tested independently before wiring them together.

---

## Testing expectations

- **API service tests**: unit tests using an in-memory SQLite database via Kysely. Test files live in `apps/api/tests/` mirroring the `src/` structure (e.g. `tests/services/apps.test.ts`). Use `createTestDb()` from `tests/utils/sqlite.ts` which wraps `bun:sqlite` with a shim that adds the `reader` boolean Kysely's `SqliteDialect` requires. Call `runMigrations(db, ...)` in `beforeAll` to apply the full schema before inserting fixtures. Run with `bun test` from `apps/api/`. Type-check test files with `bun run typecheck:test` (uses `tsconfig.test.json` which includes `bun-types`).
- **Controller and builder**: Go tests using `envtest` (no real cluster needed for unit tests)
- **UI**: Playwright for critical flows (create project, deploy app, view logs)

---

## Planned features

The MVP is complete. The following features are planned for future iterations, in no particular order.

### App types

The current `source_type` field (`git` | `image`) describes where the image comes from. A separate concept — the app's **deployment type** — controls what Kubernetes resources the controller generates. Planned types:

- `web` (default): `Deployment` + `Service` + `HTTPRoute` + `Gateway` — current behaviour
- `private`: `Deployment` + `Service` only, no `HTTPRoute`/`Gateway`. For databases, internal APIs, or any service that should only be reachable within the cluster via cluster-internal DNS (`<app-slug>.<namespace>.svc.cluster.local`)
- `cronjob`: no `Deployment` or `Service` — creates a Kubernetes `CronJob` instead. Has an additional `schedule` field (standard cron expression) and an optional `command` override. Inherits the app's env vars, secrets, and mounted volumes. UI shows last-run status instead of a live URL.

`ingress.enabled = false` in `canette.yaml` already maps to the `private` behaviour and should remain supported as an override. The deployment type is stored on the `apps` table (new `deployment_type` column) and is the primary control; `ingress.enabled` in `canette.yaml` overrides it at deploy time.

What remains:
- Migration: add `deployment_type` enum column to `apps` (`web` | `private` | `cronjob`)
- Controller: branch resource generation on `deployment_type`; add `CronJob` reconciliation path
- UI: deployment type selector on the app creation and settings pages; show `schedule` field when `cronjob` is selected

### Network isolation with internet egress

Default posture for every app namespace: deny all inter-namespace traffic and deny access to cluster-internal infrastructure, while allowing full internet egress.

- Controller generates a `NetworkPolicy` for each app namespace at creation time
- Default policy: `ingress` — allow only from the Gateway/ingress controller; `egress` — allow `0.0.0.0/0` minus RFC-1918 ranges (blocks cluster-internal) plus DNS (UDP 53)
- Per-app exceptions: user can add egress rules for specific external CIDRs or hostnames (e.g. an external managed database). Stored as a JSON field on the `apps` table, rendered as additional `NetworkPolicy` egress rules by the controller
- UI: "Network" section on the app settings page to manage egress exceptions

### Mounted volumes

Three volume types, configured via the UI and stored in the DB:

| Type | Use case |
|------|----------|
| `configmap` | Mount a file (e.g. a config file or certificate) at a specified path. Value stored in a Kubernetes `ConfigMap` in the app namespace. |
| `emptyDir` | Ephemeral shared scratch space, wiped on pod restart. |
| `persistentVolumeClaim` | Durable storage backed by a PVC. Size and `storageClass` configurable. |

Controller creates/updates the corresponding Kubernetes resources and mounts them into the `Deployment` pod spec.

### Teams

Replace the current per-project per-user membership model with team-based ownership:

- A **personal team** is automatically created for every new user at registration (name defaults to the user's name)
- Projects and apps are owned by a team, not an individual user
- Users are invited to teams; team membership grants access to all that team's projects and apps
- Roles: `owner` (can manage members and delete the team) and `member` (full access to projects/apps)
- Schema: add `teams` and `team_members` tables, move `projects.owner_id` → `projects.team_id`
- The personal team model means no UI complexity for solo users — inviting collaborators is the only new concept

### SSO login (SAML / OIDC)

Allow organisations to authenticate via their identity provider in addition to the existing GitHub OAuth / Google OAuth / magic link methods.

- **OIDC**: generic OpenID Connect support (covers Okta, Auth0, Keycloak, Azure AD, etc.)
- **SAML 2.0**: for organisations that require it
- Admin UI: configure IdP metadata URL / client ID / client secret
- Just-in-time provisioning: create a canette user on first SSO login
- Optional: enforce SSO-only login (disable magic link for non-admin accounts)

### Scheduled tasks (CronJobs)

Covered by the `cronjob` deployment type described under **App types** above.

### Multi-line secrets

The current secret input is a single-line field, making it impractical to paste certificates, private keys, or JSON service account files.

- Switch the secret value input to a resizable `textarea` when the user clicks "multi-line mode" (single-line remains the default)
- Optionally auto-detect PEM headers (`-----BEGIN`) and switch automatically
- No API or storage changes required — the encrypted value column already stores arbitrary text

---

## Runtime and package manager

Always use `bun` and `bun x` for running scripts and executing packages. Do not use `node`, `npm`, or `npx` — they are not installed on this machine.

---

## Things to never do

- Never log secret values, tokens, or credentials at any log level
- Never generate legacy `Ingress` resources — Gateway API only
- Never write Go in `apps/api` or `apps/ui`
- Never write TypeScript in `apps/controller` or `apps/builder`
- Never hardcode a namespace — namespaces come from project config or Helm values
- Never skip HMAC validation on incoming webhooks
- Never return a secret value from the API after it has been stored
- Never run build jobs as root
