# RayTrace

RayTrace is an open-source, local-first observability and experimentation tool
for coding-agent traces. It helps you inspect what an agent saw, what action it
proposed, what execution evidence exists, and how a decision changes when one
piece of context is withheld or edited.

> **Status: early prototype**
>
> RayTrace is suitable for local development, debugging, and evaluation. It is
> not yet a hardened production audit system or a multi-user service. Treat
> captured prompts, tool arguments, file contents, and model outputs as
> sensitive data.

## What it does

- Captures OpenAI Responses-compatible requests and responses through a local proxy.
- Stores trace data in SQLite, with content-addressed context storage and migrations.
- Shows a live dashboard with request timelines, context, proposed tool calls,
  metrics, summaries, and run comparison.
- Provides a counterfactual lab for decision experiments and isolated execution
  continuations.
- Correlates proposed tool calls with agent logs when available.
- Optionally collects independent process-start and exit evidence from a gVisor
  sandbox or a container tracer.
- Keeps native OpenAI/Anthropic routing available when experiment routing is disabled.

RayTrace is deliberately careful about claims: execution evidence can show that
a program started, but does not prove that its output was correct or that the
agent's final answer was correct. Missing evidence means unknown, not false.

## Quick start

### Requirements

- Node.js 22.13 or newer
- npm
- An OpenAI-compatible client or agent configured to use the local proxy

Clone the repository and install dependencies:

```sh
git clone https://github.com/<your-account>/raytace.git
cd raytace
npm install
```

Start the proxy in native-routing mode:

```sh
npm run proxy
```

Point your client at `http://127.0.0.1:8797`. Start the dashboard in another
terminal:

```sh
npm run dev
```

Open `http://localhost:3000` and send a request through the proxy. Captures are
written to `.raytace/raytace.db` and appear in the dashboard automatically.

### OpenRouter experiment mode

Copy the example environment file and add your own key:

```sh
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY
npm run proxy
```

The proxy loads `.env` from the repository root. `.env` is ignored by Git and
must never be committed. OpenRouter mode is used for summaries and
counterfactual experiments; those operations can incur API charges.

## Optional sandboxed execution

The gVisor prototype uses a dedicated Lima Linux VM and Docker. It is currently
an optional development feature, not a security certification or immutable audit
boundary.

On macOS or Linux with Lima and Docker available:

```sh
npm run sandbox:setup
npm run sandbox:run -- -- /bin/bash
```

Keep the proxy and sandbox manager running when using sandbox evidence:

```sh
npm run proxy
npm run sandbox:manager
```

See [`worker/gvisor/README.md`](worker/gvisor/README.md) for isolation details,
network behavior, persistence, evidence boundaries, and VM lifecycle commands.

## Configuration

The supported local configuration is documented in [`.env.example`](.env.example).
Important settings include:

| Variable | Purpose |
| --- | --- |
| `RAYTACE_PORT` | Local proxy port; defaults to `8797`. |
| `RAYTACE_PROVIDER` | Use `openrouter` for experiment routing; omit it for native routing. |
| `OPENROUTER_API_KEY` | Your OpenRouter key; local-only and never commit it. |
| `RAYTACE_OPENROUTER_MODEL` | OpenRouter alias or model ID used for experiments. |
| `RAYTACE_DB` | Optional SQLite database path. |
| `RAYTACE_OPENAI_UPSTREAM` | Optional OpenAI-compatible upstream override. |
| `RAYTACE_ANTHROPIC_UPSTREAM` | Optional Anthropic upstream override. |

The proxy redacts credential-shaped JSON fields before storage, but redaction is
not a guarantee of perfect data loss prevention. Review the code and your data
flows before sending private material through it.

## Data and privacy

Local runtime data is intentionally excluded from Git:

- `.env*` except `.env.example`
- `.raytace/` and generated SQLite databases
- build output, caches, dependency directories, and local deployment metadata
- private-key files such as `*.pem` and `*.key`

The client authorization header is used for forwarding and is not intended to
be persisted. Test fixtures contain fake credentials only. Do not place real
keys in source code, tests, command-line arguments, or committed fixtures.

This prototype does not provide encryption at rest, user authentication,
multi-user authorization, a retention policy, or an external immutable audit
service. The local viewer and proxy endpoints should be treated as trusted-local
development services.

## Development commands

```sh
npm run dev          # Start the dashboard
npm run proxy        # Start the local capture proxy
npm run build        # Build the dashboard
npm run lint         # Run Oxlint
npm run test:engine  # Run all proxy/unit/integration/smoke tests
```

The test suite includes a provider-free HTTP smoke test covering:

```text
capture → inspect → experiment → persistence
```

The network-backed tests bind to localhost. In restricted environments that
deny socket creation, run them in an environment that permits local test
servers.

## Architecture

```text
agent/client
    │
    ▼
local proxy (:8797) ──► OpenAI / Anthropic / OpenRouter
    │
    ├──► SQLite trace store (.raytace/raytace.db)
    ├──► dashboard (:3000)
    ├──► counterfactual experiment engine
    └──► optional gVisor/container evidence forwarder
```

The dashboard is a Vite/Vinext React application. The proxy and experiment
engine are Node.js modules. The optional gVisor collector and viewer are Python
services inside the Lima VM.

## Roadmap

Near-term work includes a setup doctor, seeded demo data, trace search and
export, stronger retention controls, authenticated endpoints, encrypted storage,
fully digest-pinned images, and broader agent/provider adapters.

## Contributing

Issues and pull requests are welcome. Please avoid including real prompts,
credentials, private repository contents, or personal filesystem paths in
issues, fixtures, screenshots, or commits. Run lint, build, and the test suite
before opening a pull request.

## License

RayTrace is released under the [MIT License](LICENSE).
