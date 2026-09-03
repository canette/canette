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
│   ├── docs/        # Fumadocs documentation site (TypeScript/MDX)
│   ├── controller/  # K8s reconciliation controller (Go)
│   ├── builder/     # Build job manager (Go)
│   ├── logstreamer/ # Live pod log streaming service (Go)
│   └── authgate/    # Per-app password-gate sidecar (Go)
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
  "volumes": [ { "id", "name", "type", "mount_path", "config" } ],
  "extra_hostnames": [ "custom.example.com" ],
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
- **Design system**: the UI follows the "Canette Dashboard v4" redesign — read `apps/ui/DESIGN.md` before styling anything. Key rules: semantic color tokens only (never raw Tailwind palette colors like `amber-600` for states); deployment-status colors go through `StatusBadge`/`StatusLabel`/`StatusDot` (`ui/status-badge.tsx`, single `statusVariant()` mapping); log/YAML output renders in the always-dark `Terminal` component; single-select pill pickers use `SegmentedControl`; cards are flat (1px border, no shadow); mono font for identifiers (slugs, shas, URLs, env keys)
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
- Streams live pod logs to the browser over SSE, and serves basic per-app runtime metrics (CPU/memory usage, pod ready/restart counts) — both are internal-only, pod-level reads proxied by the API, so they share one service, image, secret, and NetworkPolicy
- The API proxies `GET /api/v1/apps/:id/logs/stream` and `GET /api/v1/apps/:id/metrics/usage` to it — the logstreamer is never exposed directly
- Logs: on connection, polls for a `Running` pod with label `canette.dev/app=<appSlug>`, opens a following log stream, emits `event: log` SSE frames and `event: ping` keep-alives every 3 s. Logs are never stored — pure live stream, no database involvement
- Metrics: `GET /metrics/usage` reads pod health (ready/restart count) and declared resources from the core Pods API (always available), and current CPU/memory usage from `metrics.k8s.io` (metrics-server) when installed — degrades gracefully (`usageAvailable: false`) when it isn't
- `GET /metrics/timeseries` (Step 2 of [canette/canette#168](https://github.com/canette/canette/issues/168), implemented) additionally reads CPU/memory-over-time from an optional Prometheus-compatible query API (`apps/logstreamer/prometheus.go`) — a small bundled in-chart Prometheus (`metrics.prometheus.bundled`, no operator/CRDs, scrapes kubelet cAdvisor cluster-wide via the apiserver-proxy path) or a BYO `metrics.prometheus.externalUrl` (Prometheus/Thanos/Mimir/VictoriaMetrics all share the same PromQL HTTP API), with `externalUrl` taking precedence. Same graceful-degradation shape as `/metrics/usage`: returns `available: false` with HTTP 200 (never an error) whenever Prometheus isn't configured or a query fails, so the UI's stat tiles and charts silently fall back to the instant-only view. Queries are scoped with `namespace="<ns>", pod=~"<appSlug>-.*"` since a project namespace can host multiple apps and cAdvisor metrics carry no `canette.dev/*` labels — the Deployment name always equals the app slug, so this reliably isolates one app's pods. Step 3 (Traefik traffic adapter) is still future work
- Authenticated via a shared secret (`LOGSTREAMER_SECRET`) passed as `Authorization: Bearer` — must match the value configured in the API
- Restricted to in-cluster traffic only via NetworkPolicy (only the API pod may reach port 8080)

### `apps/authgate` (Go)
- Not a standalone deployed service — a sidecar image the controller injects into an individual app's own pod when that app's password gate is enabled (see "Shipped since the original MVP plan" → Password gate)
- No Kubernetes API access, no RBAC — a pure per-pod HTTP proxy in front of `localhost:<app port>`
- Verifies the bcrypt hash from `apps.password_gate_password_hash` via either an `Authorization: Basic` header or a signed session cookie set by its own embedded login form; never talks to the database directly (credentials arrive as env vars via the pod's Secret)
- Everything under the reserved `/.canette-gate/` path prefix (login, logout, healthz) is handled by the gate itself and must never fall through to the app — a catch-all on the prefix 404s for any method/path not explicitly matched, closing the gap where e.g. a `GET` on the (`POST`-registered) logout route used to be silently proxied upstream
- `AUTHGATE_INSECURE_COOKIES` (drops the `Secure` cookie attribute for local HTTP testing) only exists in a separate source file built behind the `-tags=localdev` Go build tag — the Dockerfile never passes that tag, so the option is structurally compiled out of every shipped image, not merely env-gated off by default

---

## Database schema (current)

Tables: `teams`, `team_members`, `projects`, `apps`, `deployments`, `build_logs`, `secrets`, `env_vars`, `app_volumes`, `pending_volume_deletions`, `app_hostnames`, `git_credentials`, `webhook_secrets`, `admin_settings`, `scan_sboms`, `pending_namespace_deletions`. Better-auth owns `user`, `session`, `account`, `verification` (note: `user` not `users`).

Ownership is team-based: every user gets a personal team at registration, projects/apps hang off a team, and `git_credentials` are scoped to a team (`teamId`, nullable for system-wide credentials) rather than an individual user. `git_credentials` columns: `id`, `team_id` (FK → teams, null for system credentials), `name`, `provider` enum(`github|gitlab|gitea|generic`), `type` enum(`pat|ssh_key|github_app`), `encrypted_value` (AES-256-GCM — stores the PAT token, SSH private key, or GitHub App private key), `installation_id`/`connected_by_user_id` (github_app type only), `created_at`. The `known_hosts` value for SSH credentials is not secret and is stored as plain text in a separate `ssh_known_hosts` column. Apps reference credentials via `apps.git_credential_id`.

`app_volumes` columns: `id`, `app_id`, `name`, `type` enum(`pvc|emptyDir|configmap`), `mount_path`, `config` (JSON, shape depends on `type`), `created_at`, `updated_at` — unique on `(app_id, name)` and `(app_id, mount_path)`. Async PVC/ConfigMap cleanup goes through `pending_volume_deletions` (controller claims rows via `FOR UPDATE SKIP LOCKED`).

Key invariants:
- `projects.slug` — globally unique, lowercase alphanumeric + hyphens, max 50 chars. Used as part of the K8s namespace: `can-{id[:7]}-{slug}`. Immutable after creation (changing it would orphan all K8s resources).
- `apps.slug` — unique within the project, lowercase alphanumeric + hyphens, max 63 chars. Used as the K8s container/resource name.
- `apps.project_id` references `projects.id` — deleting a project cascades to apps
- `apps.deployment_type` is an enum: `web | private | cronjob` — controls what K8s resources the controller generates (see Component responsibilities → controller); `cronjob` requires `apps.schedule` (cron expression)
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

Implemented. An extended, multi-app version of `canette.yaml` used to scaffold several apps at once — top-level `name`, optional `description`, and an `apps` array where each entry carries `name`/`slug`/`source_type`/`deployment_type` plus the same `git_*`/`image_*`/`port`/`schedule`/`env`/`secrets` fields as a single app (see `AppTemplate`/`TemplateApp`/`TemplateSecret` in `packages/types/src/index.ts`). `schedule` is required and only meaningful when `deployment_type: cronjob`; `port`/`PORT` are not used for cronjob apps. Unrecognized per-app fields are preserved and serialized back into that app's `canetteConfig` YAML rather than dropped. Volumes (`app_volumes`) are never part of a template — they're always added post-creation on the app settings page, same as for a single app.

The UI wizard lives at the project's `/from-template` route: paste or load a template file, `POST /api/v1/templates/parse` (`apps/api/src/routes/templates.ts` → `parseTemplate()` in `apps/api/src/services/templates.ts`) validates and returns one editable form per parsed app, and apps are created sequentially on confirm. It's a peer entry point to creating a single app via Git/Docker image on the "New app" page, not a separate hidden feature.

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

## Shipped since the original MVP plan

These were previously listed under "Planned features" below but are now fully implemented — schema, controller/API, and UI. Documented here so they aren't re-planned from scratch.

- **App types / deployment type**: `apps.deployment_type` (`web | private | cronjob`, migration `000005`) controls what K8s resources the controller generates. `web` gets `Deployment` + `Service` + `HTTPRoute` + `Gateway`; `private` drops the `HTTPRoute`/`Gateway` (cluster-internal DNS only, `<app-slug>.<namespace>.svc.cluster.local`); `cronjob` creates a `CronJob` instead, using `apps.schedule` (migration `000006`) and skipping `PORT` injection. `ingress.enabled = false` in `canette.yaml` still maps onto `private` as an override. Controller branches on this throughout resource generation, reconciliation, and teardown (`apps/controller/internal/k8s/resources.go`, `internal/controller/reconcile.go`, `internal/controller/teardown.go`). UI selector: shared `DeploymentTypeField` in `apps/ui/src/components/app-form-fields.tsx`, used on both the new-app and app-settings pages.
- **Mounted volumes**: three types (`pvc`, `emptyDir`, `configmap`) on the `app_volumes` table (migration `000009`/`000010`), full CRUD in `apps/api/src/services/volumes.ts`, controller reconciliation of the corresponding K8s volumes/mounts, and a "Volumes" section on the app settings page. Volumes are intentionally configured post-creation (settings), not during app creation.
- **Teams**: `teams`/`team_members` tables have existed since the initial schema migration. A personal team is created per user at registration; projects/apps and `git_credentials` are team-scoped; roles are `owner`/`member`. Full UI at `/dashboard/teams/[id]` (overview, members, credentials).
- **Custom hostnames**: admins can attach additional FQDNs to a `web` app beyond its platform-generated URL, stored on the `app_hostnames` table (migration `000011`, globally unique). `apps/api/src/services/hostnames.ts`: adding/removing a hostname is admin-only (`requireAdmin` per-route on `appsRouter`, deliberately bypassing the team-scoped `getAppById` — a global admin need not be a member of the app's team). Listing is team-scoped instead, like any other app sub-resource — a hostname is public DNS information, so any team member can see it, only mutation is admin-gated. The controller appends extra hostnames to the existing `HTTPRoute`'s `spec.hostnames` list alongside the platform-generated one (`apps/controller/internal/k8s/resources.go`) — one route, multiple hostnames, no new K8s objects. TLS is out of scope: canette never touches the Gateway's listener certificates, so a matching cert must already exist for HTTPS to work on a custom hostname. UI: the shared `HostnameManager` component (`apps/ui/src/components/hostname-manager.tsx`) provides admin-only add/remove — a "Custom domains" section on the app settings page (visible only to admins, but that route is team-scoped so unreachable for a non-member admin) and a per-app "Hostnames" dialog on the admin projects overview (`/admin/projects`), reachable for any admin regardless of team membership. Read-only awareness for everyone else: `AppLayout` (`apps/ui/src/app/(authenticated)/dashboard/projects/[slug]/apps/[appSlug]/layout.tsx`) fetches the list into `AppContext` and the shared `HostnameAltMenu` component (`apps/ui/src/components/hostname-alt-menu.tsx`) renders a small "+N" dropdown next to the primary live URL — in the per-tab header and on the Overview live-URL pill — listing every hostname as an external link.
- **Password gate**: per-app password protection for a `web` app's public URL (`apps.password_gate_enabled/password_hash`, migration `000012`, `password_gate_username` dropped in `000014`), toggled from a "Password protection" section on the app settings page (`apps/ui/src/components/password-gate-manager.tsx`). `apps/api/src/services/password-gate.ts` bcrypt-hashes the password (never stored or returned in plaintext); the controller injects an `apps/authgate` sidecar into the app's pod when enabled, switching the Service's `targetPort` to the sidecar (`AUTHGATE_SIDECAR_PORT` / `apps/api/src/services/reserved-ports.ts`, kept in sync with the Go-side `authgateSidecarPort` constant). The sidecar (own Go binary, no Kubernetes API access) verifies the same bcrypt hash via either an `Authorization: Basic` header — any username, this gates one shared password, not individual accounts — (keeps scripts/webhooks/CI working unchanged) or a branded no-JS login form for browsers, backed by an HMAC-signed session cookie whose signing key is derived from the password hash itself — changing the password invalidates existing sessions with no separate key to rotate. Originally shipped as a `caddy:2-alpine` + `basic_auth` sidecar (native browser Basic Auth prompt, username required); replaced by `apps/authgate` for a branded login experience.

## Planned features

The following features are still future work, in no particular order.

### Network isolation with internet egress

Default posture for every app namespace: deny all inter-namespace traffic and deny access to cluster-internal infrastructure, while allowing full internet egress.

- Controller generates a `NetworkPolicy` for each app namespace at creation time
- Default policy: `ingress` — allow only from the Gateway/ingress controller; `egress` — allow `0.0.0.0/0` minus RFC-1918 ranges (blocks cluster-internal) plus DNS (UDP 53)
- Per-app exceptions: user can add egress rules for specific external CIDRs or hostnames (e.g. an external managed database). Stored as a JSON field on the `apps` table, rendered as additional `NetworkPolicy` egress rules by the controller
- UI: "Network" section on the app settings page to manage egress exceptions

### SSO login (SAML / OIDC)

Allow organisations to authenticate via their identity provider in addition to the existing GitHub OAuth / Google OAuth / magic link methods.

- **OIDC**: generic OpenID Connect support (covers Okta, Auth0, Keycloak, Azure AD, etc.)
- **SAML 2.0**: for organisations that require it
- Admin UI: configure IdP metadata URL / client ID / client secret
- Just-in-time provisioning: create a canette user on first SSO login
- Optional: enforce SSO-only login (disable magic link for non-admin accounts)

### Multi-line secrets

The current secret input is a single-line field, making it impractical to paste certificates, private keys, or JSON service account files.

- Switch the secret value input to a resizable `textarea` when the user clicks "multi-line mode" (single-line remains the default)
- Optionally auto-detect PEM headers (`-----BEGIN`) and switch automatically
- No API or storage changes required — the encrypted value column already stores arbitrary text

---

## Runtime and package manager

Always use `bun` and `bun x` for running scripts and executing packages. Do not use `node`, `npm`, or `npx` — they are not installed on this machine.

---

## Linting

JS/TS linting is **oxlint**, configured by a single `.oxlintrc.json` at the repo root (with per-directory overrides for `apps/api`, `apps/ui`, `apps/docs`). ESLint has been removed — do not reintroduce it or per-package `eslint.config.*` files. Run linting with `bun run lint` (whole repo) or the per-app `lint:ui` / `lint:api` / `lint:docs` scripts; `bun run lint:fix` applies fixes (including unused-import removal, via `--fix-dangerously`). Go services still use `golangci-lint`, unchanged.

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
