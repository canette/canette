<img src="apps/docs/public/img/logo-128.png" alt="canette" width="64">

# canette

**Fast and User-Friendly PaaS for Kubernetes** · [canette.dev](https://canette.dev)

canette is a lightweight deployment platform that runs inside any Kubernetes cluster. Push a repository and get a live URL — automatic build detection, instant webhook deploys, and proven infrastructure behind the scenes.


## Who is it for?

canette is designed for developers and designers who want to host a demo, Storybook, or small internal service. You should be able to go from a Git repository to a live URL in under 2 minutes — no Dockerfile required, no Kubernetes knowledge needed.

## Why use canette?

### For developers

Most deploy platforms either require significant infrastructure knowledge or lock you into an external service. canette is different: you push code to a Git repository, and a live URL appears. There is no YAML to write, no container to build, and no Kubernetes concepts to learn.

It is particularly well suited for things that need a real URL quickly — client demos, internal tools, Storybooks, PR previews, or side projects. Every deploy gets its own URL the moment it goes live, and apps can be torn down just as easily when they are no longer needed.

### For platform and infrastructure teams

canette runs entirely inside your own Kubernetes cluster, installed as a single Helm chart. This means:

- **Full inventory.** You always know what is deployed and where. There are no apps quietly running in someone else's infrastructure and no old demos forgotten on the public internet.
- **Secure by default.** Build jobs run as non-root with no Kubernetes API access, a hard 30-minute timeout, and encrypted secrets at rest. The attack surface is minimised without requiring any custom security configuration.
- **No external dependencies.** canette does not phone home, does not require an external registry, and does not depend on any third-party SaaS. Everything runs in the cluster you already operate.
- **Standard Kubernetes primitives.** canette generates ordinary `Deployment`, `Service`, and `HTTPRoute` resources. There is no proprietary resource format, or custom CRDs — what canette creates, you can inspect, modify, or delete with standard tools.

## How it works

1. **Connect** a Git repository to a canette app
2. **Trigger** a build — canette clones your repo, detects the framework with [Railpack](https://railpack.com), and builds a container image
3. **Deploy** — the image is pushed to your in-cluster registry and a `Deployment`, `Service`, and `HTTPRoute` are applied to the cluster
4. **Access** your app at the URL canette assigns

## Key features

- **No Dockerfile needed** — Railpack auto-detects Node, Python, Go, Ruby, and more
- **GitHub OAuth** — sign in with your GitHub account
- **Private repositories** — PAT and SSH deploy key support
- **Encrypted secrets** — environment secrets are AES-256-GCM encrypted at rest
- **Real-time logs** — build and deploy logs stream live in the UI
- **Gateway API** — HTTPRoute-based routing, no legacy Ingress

---

## Requirements

- Kubernetes cluster (EKS, GKE, bare metal)
- A Gateway API implementation (Traefik, Cilium, etc.) pre-installed
- A container registry reachable from the cluster
- PostgreSQL

---

## Documentation

See [canette.dev](https://canette.dev) for installation guides, configuration reference, and architecture documentation.

For AI-assisted development, see [CLAUDE.md](./CLAUDE.md).

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, linting, and testing instructions.

---

## License

Apache 2.0
