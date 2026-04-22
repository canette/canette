# Logstreamer — local development

## What it does

The logstreamer is a small Go service that streams live pod logs to the browser over SSE. The API server proxies `GET /api/v1/apps/:id/logs/stream` to it.

When a client connects:

1. The logstreamer polls Kubernetes for a `Running` pod with the label `canette.dev/app=<appSlug>` (retries for up to 5 s)
2. Opens a following log stream from the pod (`TailLines=10, Follow=true`)
3. Formats chunks as named SSE events (`event: log`) and flushes them immediately
4. Sends a `event: ping` keep-alive every 3 s while waiting for new log lines
5. Terminates cleanly when the client disconnects

Logs are never stored — this is a pure live stream.

## Prerequisites

- k3d cluster running
- App deployed and `live` (pod must be in `Running` state)
- API server running (it proxies the SSE connection via `LOGSTREAMER_URL`)

## Running locally

### 1. Generate a shared secret

Both the logstreamer and the API need the same value:

```bash
openssl rand -hex 32
```

Set it in both `apps/logstreamer/.env` and `apps/api/.env`:

```
LOGSTREAMER_SECRET=<generated-value>
```

### 2. Start the logstreamer

```bash
cd apps/logstreamer
go run .
```

The service listens on `:8080` by default.

### 3. Point the API at it

In `apps/api/.env`, also set:

```
LOGSTREAMER_URL=http://localhost:8080
```

Then start the API server. The UI's "App Logs" panel will now open a live stream.

### 4. Test the stream directly

```bash
# Get the app's namespace and slug from the DB
NAMESPACE=can-<projectId[:8]>-<projectSlug>
APP_SLUG=<appSlug>
SECRET=<your-logstreamer-secret>

curl -N -H "Authorization: Bearer ${SECRET}" \
  "http://localhost:8080/stream?namespace=${NAMESPACE}&app=${APP_SLUG}"
```

You should see SSE-formatted output like:

```
event: log
data: Starting server on port 3000

event: ping
data: 

event: log
data: GET / 200
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `LOGSTREAMER_SECRET` | required | Shared secret for authenticating requests from the API. Must match `LOGSTREAMER_SECRET` in the API process. |
| `ADDR` | `:8080` | Address and port to listen on. |
| `KUBECONFIG` | `~/.kube/config` | Path to kubeconfig. Not needed when running in-cluster. |

## Building the binary

```bash
cd apps/logstreamer
go build -o bin/logstreamer .
```
