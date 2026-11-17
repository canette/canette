# AGENTS.md

This file contains shared instructions for coding agents working on canette. Read it before changing the codebase, and follow any additional instructions in the directory you are editing. Keep shared guidance here; the root `CLAUDE.md` imports this file for Claude Code.

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
│   ├── golib/       # Shared Go code (K8s naming, crypto, canette.yaml types)
│   └── types/       # Shared TypeScript types (api ↔ ui)
├── tools/
│   └── canette-schema/ # Generates the canette.yaml JSON Schemas (Go)
├── AGENTS.md        # Shared coding-agent instructions
└── CLAUDE.md        # Claude Code import of AGENTS.md
```

---

## Architecture decisions — read these before proposing changes

### Language split
- **TypeScript (Bun)** for `api` and `ui`. These are user-facing, iterate fast, web idioms apply.
- **Go** for `controller` and `builder`. These talk directly to the Kubernetes API via `client-go`. Do not introduce TypeScript in these packages. Do not introduce Go in the TypeScript packages.

### The controller is a reconciliation loop, not a job runner
The controller reads desired state from the database and reconciles it with the cluster. It does not respond to webhooks directly. The API server handles webhooks, writes desired state to the database, and the controller picks it up. This is the Kubernetes operator pattern — respect it.

### Gateway API only — no legacy Ingress
canette generates `HTTPRoute` resources referencing a pre-existing Gateway configured by `controller.gateway.name` and `controller.gateway.namespace` in Helm values. Gateway provisioning, its class, listeners, and TLS certificates are managed by the cluster operator. Never generate `networking.k8s.io/v1 Ingress` resources.

### Kubernetes naming lives in Go only
Namespaces and K8s resource names are a Kubernetes concern and are computed only on the Go side, through `packages/golib/k8s` (e.g. `AppNamespace()`). The API never computes, stores or passes a namespace or K8s resource name. It works with domain identifiers (`project_id`, `project_slug`, `app_slug`, volume name, deployment ID), and the Go services resolve those to K8s names. Duplicating that logic in TypeScript means it can silently drift, which orphans resources. Examples of the right shape: `queued_namespace_cleanups` stores `project_id` + `project_slug`, `pending_volume_deletions` stores `project_id`/`project_slug`/`app_slug`/`volume_name`/`volume_type` (the controller resolves them via `VolumeResource()`, the same helper used to create the PVC/ConfigMap), and the API sends the logstreamer `project_id`/`project_slug`/`app`, never a namespace. The API may know length *budgets* that K8s naming imposes (e.g. `VOLUME_RESOURCE_NAME_OVERHEAD` in `volumes.ts`, for up-front validation) but never the naming formula itself.

### Database
PostgreSQL via the `pg` npm package (TypeScript) and `jackc/pgx/v5` (Go). Never modify the schema without a migration file.

**Migration files** live in `apps/api/migrations/` as plain SQL — one `{version}_{description}.up.sql` and one `.down.sql` per migration. The version prefix is a zero-padded number (e.g. `000001`). Always use `CURRENT_TIMESTAMP` instead of `NOW()` — it works on both PostgreSQL and SQLite (used in tests).

**Migration runner** (`apps/api/src/db/migrations.ts`) accepts any Kysely `DB` instance, reads the `.up.sql` files in order, splits each file on `;` and executes statements one at a time, and tracks applied versions in a `schema_migrations` table. The runner is invoked directly by `apps/api/src/index.ts` at startup unless `RUN_MIGRATIONS=false`. The standalone `apps/api/scripts/migrate.ts` entry point also reads `MIGRATIONS_DIR` from the environment (defaults to `./migrations` relative to cwd — matches the directory next to the compiled binary).

Local dev: provide a PostgreSQL database and set `DATABASE_URL` in `apps/api/.env`. Run `bun run --cwd apps/api db:migrate` to apply pending migrations. See `CONTRIBUTING.md` and the self-hosting documentation for setup requirements.

### Secrets
App secrets (env vars) are encrypted at rest with AES-256-GCM. The master key comes from a Kubernetes Secret created at Helm install time. The API encrypts values when storing them; the Go controller decrypts them at deploy time and creates Kubernetes Secrets in the app's namespace. Secret values are never logged, never returned by the API after being set, and never stored in plaintext.

### Build jobs
Each build runs as a Kubernetes Job in the build namespace configured through Helm (see `canette.buildNamespace`), separate from the platform services. The job has two stages:
1. `git-clone` — init container, clones the source into a shared `emptyDir` volume
2. `image-build` — main container, runs `canette-build`, using Railpack for automatic build detection or BuildKit directly for a configured Dockerfile, then pushes the image

The job connects to a separate, shared BuildKit daemon through `BUILDKIT_HOST`; it does not embed a daemon or run one as a sidecar. See `apps/builder/internal/k8s/jobs.go` and `charts/canette/templates/buildkit/deployment.yaml`.

- Build jobs run as non-root UID/GID 10001 with `RuntimeDefault` seccomp and no service-account token. Keep these defaults.
- The BuildKit daemon defaults to rootless mode (UID 1000), with unconfined seccomp/AppArmor and `--oci-worker-no-process-sandbox`; its state is an `emptyDir` at `/home/user/.local/share/buildkit`.
- `buildkit.rootless: false` is an explicit operator option that runs the daemon privileged. This does not change the non-root build-job security context.
- Rootless BuildKit requires node user-namespace support; consult `apps/docs/content/docs/self-hosting/requirements.mdx` before changing its configuration.
- Scheduling settings and build timeouts come from Helm values; never hardcode them.
- Use Railpack/BuildKit, not nixpacks or kaniko.

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
Auth is handled by `better-auth` embedded in the API server. Supported methods include email/password, Google OAuth, GitHub OAuth, generic OIDC, and email magic link (requires the configured Resend email provider). Do not add Keycloak, Dex, or any external auth service as a dependency.

**better-auth schema is hand-migrated, not library-managed.** better-auth owns `user`/`session`/`account`/`verification`, but this repo does not use its CLI or `getMigrations()` to manage them in Postgres — those tables are created and altered by the same hand-written SQL files in `apps/api/migrations/` as everything else (see initial schema in `000001_initial_schema.up.sql`). This means every field a configured plugin adds (`admin` → `user.role/banned/banReason/banExpires`, `session.impersonatedBy`; future plugins add their own) must be mirrored into a migration by hand — better-auth will not create or alter these columns itself. When adding a plugin or bumping the `better-auth` version, run `bunx @better-auth/cli generate` against `apps/api/src/auth/auth.ts` to see what columns/tables it now expects, and hand-write the equivalent `ALTER TABLE`/`CREATE TABLE` into a new migration — do not run its `migrate` command directly against the database.

`apps/api/tests/auth/auth.test.ts` guards against drift between the two: it provisions its in-memory SQLite database from the real migrations in `apps/api/migrations/` (via `runMigrations`, same as every other test suite), not from better-auth's own `getMigrations()`. Because better-auth validates its schema against the live database on every write, any plugin field missing from the migrations fails a test immediately (`SchemaMismatchError`) instead of surfacing at runtime in production. Never change this test back to building its schema from `getMigrations()` — that generates a schema from the plugin config itself and can never detect drift from what's actually migrated.

**Startup order: migrations before `auth.ts` is loaded.** better-auth runs its schema check the moment `betterAuth()` is constructed and caches a failed result for the life of the process. `apps/api/src/index.ts` therefore statically imports only `db` + `migrations`, and loads `./app` (which reaches `auth.ts`) via dynamic `await import()` after `runMigrations()`. It then calls `verifyAuthSchema()` (`src/auth/verify-schema.ts`), which exits the process on a schema mismatch so drift fails the deploy instead of 500ing on the first sign-up. `tests/startup-order.test.ts` walks the static import graph of `index.ts` and fails if `auth.ts` becomes reachable — don't add static imports of app/auth/route modules to `index.ts`.

---

## Component responsibilities

### `apps/api` (TypeScript · Bun · Hono)
- Application REST endpoints under `/api/v1`; authentication under `/api/auth`, MCP under `/mcp`, and OAuth discovery/authorization under `/.well-known` and `/oauth`
- Webhook receiver for GitHub, GitLab, Gitea (provider-specific signature/token validation required)
- Secret encryption/decryption
- Auth middleware (better-auth sessions)
- Writes desired state to the database
- Does NOT talk to the Kubernetes API directly (that's the controller's job)
- MCP tools live in `src/services/mcp/tools/<domain>.ts`: one `defineTool()` per tool, holding its definition and handler, and each domain's list is registered in `src/services/mcp/registry.ts` (whose order is the `tools/list` order). Tool errors use `err(message, code)` / `notFound()` from `src/services/mcp/tool.ts`

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
- `GET /logs/tail` is a one-shot, non-following counterpart to the SSE stream, used by the API's MCP tools (`get_runtime_logs`): returns JSON with the app's newest pod (any phase, optionally scoped by `deployment_id`), its status (ready/restarts/waiting reason/last exit) and the last N lines of the app container (never the authgate sidecar), falling back to the previous container instance when the current one is crash-looping. `found: false` with HTTP 200 when the app has no pods
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

Tables: `teams`, `team_members`, `projects`, `apps`, `deployments`, `build_logs`, `secrets`, `env_vars`, `app_volumes`, `pending_volume_deletions`, `app_hostnames`, `git_credentials`, `webhook_secrets`, `admin_settings`, `scan_sboms`, `queued_namespace_cleanups`. Better-auth owns `user`, `session`, `account`, `verification` (note: `user` not `users`).

Ownership is team-based: every user gets a personal team at registration, projects/apps hang off a team, and `git_credentials` are scoped to a team (`teamId`, nullable for system-wide credentials) rather than an individual user. `git_credentials` columns: `id`, `team_id` (FK → teams, null for system credentials), `name`, `provider` enum(`github|gitlab|gitea|generic`), `type` enum(`pat|ssh_key|github_app`), `encrypted_value` (AES-256-GCM — stores the PAT token, SSH private key, or GitHub App private key), `installation_id`/`connected_by_user_id` (github_app type only), `created_at`. The `known_hosts` value for SSH credentials is not secret and is stored as plain text in a separate `ssh_known_hosts` column. Apps reference credentials via `apps.git_credential_id`.

`app_volumes` columns: `id`, `app_id`, `name`, `type` enum(`pvc|emptyDir|configmap`), `mount_path`, `config` (JSON, shape depends on `type`), `created_at`, `updated_at` — unique on `(app_id, name)` and `(app_id, mount_path)`. Async PVC/ConfigMap cleanup goes through `pending_volume_deletions` (controller claims rows via `FOR UPDATE SKIP LOCKED`). Rows carry domain identifiers; the nullable `namespace`/`resource_type`/`resource_name` columns only exist for rows queued before migration `000018` and can be dropped in a later release.

Key invariants:
- `projects.slug` — globally unique, lowercase alphanumeric + hyphens, max 50 chars. Used as part of the K8s namespace: `can-{id[:8]}-{slug[:50]}` (computed only in Go by `AppNamespace()` in `packages/golib/k8s`). Can only be changed while every app in the project is stopped (`updateProject()` in `apps/api/src/services/projects.ts`): the rename clears `applied_manifest` on stopped deployments and queues the old namespace in `queued_namespace_cleanups`, so the next deploy recreates everything in the new namespace. The old namespace is deleted with everything in it, including PVC data. Never allow a rename while resources are live, or they are orphaned.
- `apps.slug` — unique within the project, lowercase alphanumeric + hyphens, max 63 chars. Used as the K8s container/resource name.
- `apps.project_id` references `projects.id` — deleting a project cascades to apps
- `apps.deployment_type` is an enum: `web | private | cronjob` — controls what K8s resources the controller generates (see Component responsibilities → controller); `cronjob` requires `apps.schedule` (cron expression)
- `deployments.status` is an enum: `pending_build | building | scanning | pending_deployment | deploying | live | failed | stopped`
- `secrets.encrypted_value` is never null — empty string is stored encrypted
- `user.role` is `admin | developer`

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

security:               # opt-in hardened mode, see below
  hardened: true
  writable_paths: ["/tmp"]
  read_only_root_filesystem: true
  user: 10001
```

When parsing `canette.yaml`, unknown fields must be silently ignored (forward compatibility). Validation errors must return a clear human-readable message — never a raw Go/JS error.

### canette.yaml types and JSON Schema

The file format is defined once, in `packages/golib/canetteyaml`: `BuildConfig` (decoded by the builder), `RuntimeConfig` (decoded by the controller, aliased as `config.CanetteRuntimeConfig`) and `Config` (both, plus the informational `secrets` list). Each service decodes only its own part, so a type error in a runtime field can't fail a build and vice versa. `BuildSpec.Validate()` lives there too.

The published JSON Schemas (`apps/docs/public/schema/canette.json` and `canette-template.json`, served at `https://canette.dev/schema/…`) are generated from those types by `tools/canette-schema` (its own Go module, so `invopop/jsonschema` stays out of the service modules). Doc comments on the types become the field descriptions, so write them for an agent that hasn't read the docs. Constraints that `BuildSpec.Validate()` enforces are applied by the generator from the exported constants and patterns in `canetteyaml/validate.go` (not from struct tags, which can't express map-key rules and which the library silently drops on maps), and `tools/canette-schema/main_test.go` checks the schema and the validator accept and reject the same values. `Quantity` (cpu/memory) accepts a string in the Kubernetes quantity format or a bare number. **Never hand-edit the schema files**: change the Go types, then run `bun run generate:schema` and commit the result. The `schema` job in `build-go.yml` regenerates them and fails on any diff. New fields go into these types.

The template wrapper (`name`/`description`/`apps[]` and the per-app fields) is defined in `tools/canette-schema/template.go`, because templates are parsed in TypeScript (`apps/api/src/services/templates.ts`). `apps/api/tests/schema/schema.test.ts` fails when `APP_ROW_FIELDS` names a field the template schema lacks, or when the template schema describes a field that is neither in `APP_ROW_FIELDS` nor a canette.yaml field. The API bakes both schema files into its binary through a Bun macro (`src/docs/load-schemas.ts`, same pattern as the MCP docs bundle) and serves them through the `get_canette_yaml_schema` MCP tool and `canette-schema://` resources.

### canette.yaml field ownership

Fields are split between the database (set via UI) and `canette.yaml` (committed to the repo):

| Field | Owned by | Notes |
|-------|----------|-------|
| `build.context`, `build.dockerfile`, `build.args` | `canette.yaml`, with the app's stored `canette_config` as base | Parsed at build time by `canette-build`: the stored config (passed as `CANETTE_CONFIG`) is the base layer, the repo's `canette.yaml` wins field by field. Git apps only |
| `runtime.port`, `runtime.command`, `replicas`, `resources`, `healthcheck` | DB (UI) as base, `canette.yaml` overrides at deploy time | File wins when present; DB value is the fallback |
| `env` | `canette.yaml` only | Plaintext vars safe to commit; merged on top of any DB-stored env vars at deploy time |
| `secrets` | DB only (values); `canette.yaml` can list names | Secret values are never in the file; names in the file are informational. This feature is only useful if we introduce project wide secrets |
| `ingress.enabled` | DB (UI) as base, `canette.yaml` overrides at deploy time | `ingress.enabled = false` still creates a service, but no httproute. Useful for eg. databases |
| `security` | `canette.yaml` only | Opt-in hardened mode, see below. No DB column |

**Merge happens at deploy time, not on UI interaction.** The UI always reads and writes DB values. The builder stores repository YAML emitted by `canette-build` in the deployment record; the controller reads that record and applies overrides when constructing K8s resources. It does not read the build workspace. The UI may show a note that certain fields could be overridden by `canette.yaml`.

### Hardened mode (`security`)

An opinionated preset, not a set of raw securityContext fields (#251). `security.hardened: true` sets on the **app container only** (never the authgate sidecar): `runAsNonRoot`, `runAsUser`/`runAsGroup` = `user` (default `DefaultHardenedUser` 10001), `readOnlyRootFilesystem`, `capabilities.drop: [ALL]`; and on the pod `fsGroup` = `user` with `fsGroupChangePolicy: OnRootMismatch`. Together with the #250 defaults this meets PSA `restricted`. Escape hatches: `writable_paths` (emptyDir mounts, default `["/tmp"]`, `[]` = none, a user volume on the same path wins), `read_only_root_filesystem: false`, `user`. All three are ignored (with a deploy-log warning) unless `hardened: true`.

- Types and `SecuritySpec.Validate()` live in `packages/golib/canetteyaml`; the custom `UnmarshalYAML` in `security.go` turns type errors into field-named messages.
- The controller resolves it with `config.ResolveSecurity()`, which decodes only the `security` block. An invalid block is a `*config.SecurityError` and **fails the deployment** (`reconcile.go`), unlike every other canette.yaml error, which only logs a warning and falls back to defaults — silently deploying without requested hardening would be worse than failing.
- Pod Security Admission warnings from the apply are collected per deployment (`k8s.WithWarningCollector` + the context-aware `warningLogger` in `main.go`) and written to the deploy log, with a hint to hardened mode when it's off.
- User docs: `apps/docs/content/docs/security/hardened-mode.mdx` (stack recipes, tested against railpack 0.23 images). railpack images run as root with world-readable `/app`, so they work hardened unchanged.

### canette-template.yaml

Implemented. An extended, multi-app version of `canette.yaml` used to scaffold several apps at once — top-level `name`, optional `description`, and an `apps` array where each entry carries `name`/`slug`/`source_type`/`deployment_type` plus the same `git_*`/`image_*`/`port`/`schedule`/`env`/`secrets` fields as a single app (see `AppTemplate`/`TemplateApp`/`TemplateSecret` in `packages/types/src/index.ts`). `schedule` is required and only meaningful when `deployment_type: cronjob`; `port`/`PORT` are not used for cronjob apps. Unrecognized per-app fields are preserved and serialized back into that app's `canetteConfig` YAML rather than dropped. Volumes (`app_volumes`) are never part of a template — they're always added post-creation on the app settings page, same as for a single app.

The UI wizard lives at the project's `/from-template` route: paste or load a template file, `POST /api/v1/templates/parse` (`apps/api/src/routes/templates.ts` → `parseTemplate()` in `apps/api/src/services/templates.ts`) validates and returns one editable form per parsed app, and apps are created sequentially on confirm. It's a peer entry point to creating a single app via Git/Docker image on the "New app" page, not a separate hidden feature.

---

## REST API conventions

- Application REST endpoints under `/api/v1`; authentication, MCP, OAuth, and health endpoints have separate paths (see `apps/api/src/app.ts`)
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

## Testing expectations

- **API service tests**: unit tests using an in-memory SQLite database via Kysely. Test files live in `apps/api/tests/` mirroring the `src/` structure (e.g. `tests/services/apps.test.ts`). Use `createTestDb()` from `tests/utils/sqlite.ts` which wraps `bun:sqlite` with a shim that adds the `reader` boolean Kysely's `SqliteDialect` requires. Call `runMigrations(db, ...)` in `beforeAll` to apply the full schema before inserting fixtures. Run with `bun test` from `apps/api/`. Type-check test files with `bun run typecheck:test` (uses `tsconfig.test.json` which includes `bun-types`).
- **Go suites**: standard Go tests, including fake Kubernetes clients and in-process HTTP servers; no envtest setup or live cluster is required. From the repository root, run `go test ./apps/authgate/... ./apps/builder/... ./apps/controller/... ./apps/logstreamer/... ./packages/golib/... ./tools/canette-schema/...` to cover all workspace modules.
- **UI and docs**: no browser/Playwright test suite is currently configured. Validate relevant changes with linting, type checking, and builds; manually check affected user flows.
- **CI coverage**: `build-go.yml` builds, lints, and tests the service/tool modules and checks generated schemas. `build-ts.yaml` lints and builds UI/API but currently does not run API tests. Run `bun run test:api` locally for API changes; do not assume a green PR build covers those tests.

---

## Shipped since the original MVP plan

These were previously listed under "Planned features" below but are now fully implemented — schema, controller/API, and UI. Documented here so they aren't re-planned from scratch.

- **App types / deployment type**: `apps.deployment_type` (`web | private | cronjob`, migration `000005`) controls what K8s resources the controller generates. `web` gets `Deployment` + `Service` + `HTTPRoute` referencing the configured Gateway; `private` drops the `HTTPRoute` (cluster-internal DNS only, `<app-slug>.<namespace>.svc.cluster.local`); `cronjob` creates a `CronJob` instead, using `apps.schedule` (migration `000006`) and skipping `PORT` injection. `ingress.enabled = false` in `canette.yaml` still maps onto `private` as an override. Controller branches on this throughout resource generation, reconciliation, and teardown (`apps/controller/internal/k8s/resources.go`, `internal/controller/reconcile.go`, `internal/controller/teardown.go`). UI selector: shared `DeploymentTypeField` in `apps/ui/src/components/app-form-fields.tsx`, used on both the new-app and app-settings pages.
- **Mounted volumes**: three types (`pvc`, `emptyDir`, `configmap`) on the `app_volumes` table (migration `000009`/`000010`), full CRUD in `apps/api/src/services/volumes.ts`, controller reconciliation of the corresponding K8s volumes/mounts, and a "Volumes" section on the app settings page. Volumes are intentionally configured post-creation (settings), not during app creation.
- **Teams**: `teams`/`team_members` tables have existed since the initial schema migration. A personal team is created per user at registration; projects/apps and `git_credentials` are team-scoped; roles are `owner`/`member`. Full UI at `/dashboard/teams/[id]` (overview, members, credentials).
- **Custom hostnames**: admins can attach additional FQDNs to a `web` app beyond its platform-generated URL, stored on the `app_hostnames` table (migration `000011`, globally unique). `apps/api/src/services/hostnames.ts`: adding/removing a hostname is admin-only (`requireAdmin` per-route on `appsRouter`, deliberately bypassing the team-scoped `getAppById` — a global admin need not be a member of the app's team). Listing is team-scoped instead, like any other app sub-resource — a hostname is public DNS information, so any team member can see it, only mutation is admin-gated. The controller appends extra hostnames to the existing `HTTPRoute`'s `spec.hostnames` list alongside the platform-generated one (`apps/controller/internal/k8s/resources.go`) — one route, multiple hostnames, no new K8s objects. TLS is out of scope: canette never touches the Gateway's listener certificates, so a matching cert must already exist for HTTPS to work on a custom hostname. UI: the shared `HostnameManager` component (`apps/ui/src/components/hostname-manager.tsx`) provides admin-only add/remove — a "Custom domains" section on the app settings page (visible only to admins, but that route is team-scoped so unreachable for a non-member admin) and a per-app "Hostnames" dialog on the admin projects overview (`/admin/projects`), reachable for any admin regardless of team membership. Read-only awareness for everyone else: `AppLayout` (`apps/ui/src/app/(authenticated)/dashboard/projects/[slug]/apps/[appSlug]/layout.tsx`) fetches the list into `AppContext` and the shared `HostnameAltMenu` component (`apps/ui/src/components/hostname-alt-menu.tsx`) renders a small "+N" dropdown next to the primary live URL — in the per-tab header and on the Overview live-URL pill — listing every hostname as an external link.
- **Password gate**: per-app password protection for a `web` app's public URL (`apps.password_gate_enabled/password_hash`, migration `000012`, `password_gate_username` dropped in `000014`), toggled from a "Password protection" section on the app settings page (`apps/ui/src/components/password-gate-manager.tsx`). `apps/api/src/services/password-gate.ts` bcrypt-hashes the password (never stored or returned in plaintext); the controller injects an `apps/authgate` sidecar into the app's pod when enabled, switching the Service's `targetPort` to the sidecar (`AUTHGATE_SIDECAR_PORT` / `apps/api/src/services/reserved-ports.ts`, kept in sync with the Go-side `authgateSidecarPort` constant). The sidecar (own Go binary, no Kubernetes API access) verifies the same bcrypt hash via either an `Authorization: Basic` header — any username, this gates one shared password, not individual accounts — (keeps scripts/webhooks/CI working unchanged) or a branded no-JS login form for browsers, backed by an HMAC-signed session cookie whose signing key is derived from the password hash itself — changing the password invalidates existing sessions with no separate key to rotate. Originally shipped as a `caddy:2-alpine` + `basic_auth` sidecar (native browser Basic Auth prompt, username required); replaced by `apps/authgate` for a branded login experience.

- **Multi-line environment values and secrets**: `apps/ui/src/components/env-value-field.tsx` provides the shared single-line/textarea toggle and PEM-header detection. It is used in app forms, settings, and the agent secret-request page. Reuse it rather than adding another secret editor.

## Planned features

The following features are still future work, in no particular order.

### Per-app network exceptions

Default namespace isolation is already implemented in `apps/controller/internal/k8s/resources.go`, enabled by `controller.networkPolicy.enabled`. It allows same-project namespace traffic, ingress from the configured Gateway namespace, DNS to `kube-system` on TCP/UDP 53, and internet egress excluding reserved address ranges. Enforcement requires a CNI that supports NetworkPolicy. Per-app egress exceptions and a Network settings UI remain future work; do not reimplement the existing default policy.

### SAML and SSO administration

Generic OIDC login and SSO-only enforcement are already implemented through better-auth's `genericOAuth` plugin (`apps/api/src/auth/options.ts`) and Helm `auth.oidc` settings. `OIDC_ENFORCE=true` disables email/password, magic link, and social-provider login for all users, including admins. See `apps/docs/content/docs/configuration/authentication.mdx`. SAML support and an admin UI for IdP configuration remain future work.

---

## Runtime and package manager

Always use `bun` and `bun x` for running scripts and executing packages. Do not substitute `node`, `npm`, or `npx` for repository development commands. Application runtime commands and Dockerfiles may still use Node.js.

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
- Never compute a Kubernetes namespace or resource name in `apps/api` or `apps/ui` — pass domain identifiers and let the Go services resolve them via `packages/golib/k8s`
- Never skip provider-specific signature/token validation on incoming webhooks (HMAC for GitHub/Gitea, shared token for GitLab)
- Never return a secret value from the API after it has been stored
- Never run build jobs as root
