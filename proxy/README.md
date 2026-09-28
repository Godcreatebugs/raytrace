# RayTrace capture proxy

Run `npm run proxy`. Set a compatible client base URL to `http://127.0.0.1:8797`; exchanges are forwarded to OpenAI or Anthropic and recorded in `.raytace/evidence.db`.

Port 8797 is the default (moved off 8787 because another local tool was using it). Set `RAYTACE_PORT` in `.env` to change the port for both the proxy and Codex launcher.

Configure alternate endpoints with `RAYTACE_OPENAI_UPSTREAM` and `RAYTACE_ANTHROPIC_UPSTREAM`. JSON fields resembling credentials are redacted before storage. Production needs encrypted storage, stronger DLP rules, authenticated ingestion, and an object store for streaming payloads.

## Storage

Captures are stored in SQLite at `.raytace/evidence.db`, created automatically
on first run by `proxy/init-evidence-db.mjs`. There is nothing to install and no
service to start: the engine is `node:sqlite`, built into Node 22.

The schema is `proxy/schema/*.sql` (see `proxy/schema/EVIDENCE_DATABASE.md`),
and `proxy/evidence-store.mjs` is the only module that reads or writes it:

- **Agent intent**, written as each model request is captured:
  `agent_sessions` → `agent_turns` (one user prompt and the agent's work on it)
  → `agent_exchanges` (one model request) → `agent_tool_calls` (proposals, with
  the agent's reported result). Which turn a request belongs to is decided once,
  here: a new user message opens a turn, requests that carry the same
  conversation plus the agent's own work continue it, and background jobs
  (title generation, catch-ups) belong to none.
- **Runtime evidence**, written by the gVisor forwarder: `runtime_sandboxes`,
  `runtime_processes` (identified by pid + start time), `runtime_events`, and
  `runtime_attributions` tying a process to the call it ran for.
- **Classification** and **file context** tables exist and stay empty until file
  syscalls are captured.
- **Auxiliary**: lab experiments, cached summaries and explanations, command
  descriptions, proxy errors.

Payloads are content-addressed in `agent_payloads`. An agent resends its entire
history and tool list on every request, so each input item and the tool list are
stored once and referenced by every request that included them.

`RAYTACE_DB` overrides the database path. There are no migrations: the database
carries `PRAGMA user_version = 2`, and anything else (an older database, a
changed schema) is refused untouched; delete it to start fresh. Write-ahead
logging is enabled where the filesystem supports it, so the dashboard can read
while the proxy writes; on mounts that cannot provide it the store falls back
to a rollback journal. `RAYTACE_ARCHIVE_JSONL=1` also appends each raw capture
to `.raytace/events.jsonl`.

A proposed call with no attributed process reports as `not_executed`: nothing
was observed for it, which is not proof that it never ran.

## Optional OpenRouter routing

Copy `.env.example` to `.env` and put your OpenRouter key in `OPENROUTER_API_KEY`. The proxy and launcher load this file automatically from the project root; `.env` is ignored by Git.

```dotenv
RAYTACE_PROVIDER=openrouter
OPENROUTER_API_KEY=your-key-here
RAYTACE_OPENROUTER_MODEL=coder
```

Run `npm run proxy` in one terminal, then `npm run codex` in another. The launcher uses a temporary Codex provider pointed at RayTrace and leaves your saved Codex settings untouched. Additional CLI arguments work, for example `npm run codex -- --model deepseek`.

### Containerized Codex (opt-in)

Set `RAYTACE_CONTAINER=1` before `npm run codex` to run Codex's entire process inside a Docker container instead of directly on this machine, so its shell commands can only touch what is explicitly bind-mounted in (your project directory and `CODEX_HOME`, not your whole home directory):

```
npm run docker:build     # once, or whenever docker/ changes
RAYTACE_CONTAINER=1 npm run codex
```

This mode captures model traffic only. Observed execution evidence comes from the gVisor sandbox below.

- `docker/codex/Dockerfile` assumes Codex installs via `npm install -g @openai/codex`. If that's not how you installed it locally, edit that line before building.
- `RAYTACE_PROVIDER=native` is untested in container mode: Codex's own `~/.codex/config.toml` may point at `127.0.0.1`, which won't resolve to this Mac from inside the container. OpenRouter mode rewrites the base URL automatically.


### gVisor sandbox sessions: per-call verdicts from the sandbox's own evidence

gVisor is the only execution witness. For sessions started through the gVisor sandbox (`npm run dev:all`, or `npm run sandbox:*`; see `worker/gvisor/README.md`) the proxy runs a forwarder (`proxy/gvisor-forwarder.mjs`):

1. It asks the sandbox manager (`:8799/api/projects`) which `rtp-…` sandbox ids map to which container ids, and samples the VM's clock (`:8798/time`) to map sandbox event times onto the proxy's.
2. It tails each container's `exec_succeeded` / `exec_failed` / `process_exit` events from the evidence viewer (`:8798/events?after=<cursor>`, port-forwarded out of the Lima VM). Every process is recorded in `runtime_processes`, whether or not it matches a call.
3. Each *top-level* exec (Codex's `/bin/bash -lc <cmd>` wrapper) is matched against that session's proposed calls by command text **inside the call's causal window**: after the request that proposed it started, before the request that carried its result back. A match becomes a `runtime_attributions` row (`method = 'window'`); processes it starts inherit the call (`method = 'inherited'`). A process carrying `RAYTRACE_CALL_ID` is joined exactly (`method = 'marker'`).
4. Its `process_exit` closes the process with the real exit code, found by pid + start time so it works across proxy restarts. The agent's own reported exit code and wall time are checked against it (`reported_check`).

An exec that doesn't clear the similarity bar stays recorded but unattributed, and its call stays `not_executed`: a wrong match is the failure mode this is tuned against. The forwarder is on by default and best-effort: with no manager or VM running it logs one line and idles. `RAYTACE_GVISOR_FORWARDER=0` disables it; `RAYTACE_SANDBOX_MANAGER` / `RAYTACE_EVIDENCE_VIEWER` override the two base URLs. After changing `worker/gvisor/collector.py` or `viewer.py`, push them into the VM without a full re-setup, then restart running sandboxes so they reconnect to the collector:

```
limactl copy worker/gvisor/viewer.py raytace-gvisor:/tmp/viewer.py
limactl shell raytace-gvisor sudo cp /tmp/viewer.py /opt/raytace/viewer.py
limactl shell raytace-gvisor sudo systemctl restart raytace-viewer
```


The OpenRouter launcher labels each new Codex launch as a separate session. Once its first response is captured, the dashboard shows the latest session only and switches away from older prompts automatically. The Compare runs picker loads the most recent 100 saved runs across all sessions, including older captures without session tracking. The main timeline remains scoped to the latest session. Restarting the dashboard does not delete captures; older sessions stay in the database. Clients without session headers are grouped by proxy run, so restart the proxy to start a fresh group for those clients.

To switch back, comment out **only** `RAYTACE_PROVIDER=openrouter`, restart the proxy, and launch a **new session** with `npm run codex`. The launcher then invokes ordinary Codex with your existing configuration and authentication. Native capture still requires your existing client base-URL setup. Existing shell environment variables take precedence over `.env`; unset an exported `RAYTACE_PROVIDER` if necessary.

The default shortlist is in `proxy/providers.mjs`:

| Alias | OpenRouter model |
| --- | --- |
| `coder` (default) | [qwen/qwen3-coder](https://openrouter.ai/qwen/qwen3-coder) |
| `deepseek` | [deepseek/deepseek-v3.2](https://openrouter.ai/deepseek/deepseek-v3.2) |
| `oss` | [openai/gpt-oss-120b](https://openrouter.ai/openai/gpt-oss-120b) |
| `flash` | [google/gemini-2.5-flash-lite](https://openrouter.ai/google/gemini-2.5-flash-lite) |

Replace the shortlist in `.env` to configure your own models without changing code:

```dotenv
RAYTACE_OPENROUTER_MODELS='{"x":"qwen/qwen3-coder","y":"deepseek/deepseek-v3.2"}'
RAYTACE_OPENROUTER_MODEL=x
```

Restart the proxy, then start a new Codex session with `npm run codex -- --model x` or `npm run codex -- --model y`. The launcher resolves aliases to full model IDs and rejects unknown selections before starting Codex. If no default is specified, the first alias in the list is used. Both processes must use the same configuration.

Consult the linked model pages for current prices and tool capabilities. This selects one model per request, without automatic multi-model fan-out or automatic fallback on quota errors. A request's `model` can select an alias or a listed full ID. Native model names sent directly to the proxy use the configured default while OpenRouter is enabled; unlisted full IDs are rejected.

OpenRouter usage is billed separately and subject to its own account/provider limits. Choosing another model does not increase context windows or reduce the amount of conversation history sent. RayTrace records observable requests, answers, tool calls/results, and exposed reasoning summaries; it does not reconstruct private chain of thought.

Other compatible clients can use `http://127.0.0.1:8797/v1` for Responses or Chat Completions. The proxy supplies its OpenRouter key and does not forward client account credentials to OpenRouter. Anthropic Messages continue using the existing Anthropic upstream. Captures identify the routed model/provider; Responses experiments replay the same routed snapshot. Missing keys and provider errors do not trigger a native fallback.

OpenRouter's [Responses API](https://openrouter.ai/docs/api/reference/responses/overview) requires full history on each request, `store:false` (or omitted), and no `previous_response_id`. Start fresh sessions when switching providers. This integration passes tool schemas through; compatibility with Codex-specific tools varies by model/provider. Stateful Responses, WebSockets, and `/responses/compact` are not implemented by this router. The existing proxy buffers streaming responses before returning them. A full live Codex tool-use session still needs validation with your key.

Codex launcher configuration follows the official [custom provider documentation](https://developers.openai.com/codex/config-advanced/). This launcher configures the CLI; it does not reconfigure an already running Codex desktop session.

Run `npm run test:engine` for local tests of native/OpenRouter capture, model selection, credential isolation, and experiment replay. They use mock upstreams and make no paid API calls.

## Selected-step lab

Select a proposed tool call or answer in the timeline. “Explore this decision” uses the input snapshot before that response, ranks up to three candidate context items by matching file/function references, and labels them as hypotheses. It does not recover private reasoning or assign causal probabilities. Click a hypothesis to preload its context, edit the text, and choose a configured model.

- **Replay model decision:** 2–20 runs per version compare original and edited context using the same selected model. Matching looks for the selected tool name and exact arguments anywhere in the new response; answer matching uses exact text. The percentages are observed repeat rates with Wilson intervals. Failed responses are excluded and stop the batch.
- **Execute and continue:** one fresh, ephemeral Codex execution reconstructed from the edited transcript. Uses a separate copy of current Git-listed project files (including uncommitted changes), not a historical snapshot or exact session resume. Symlinks, environment files, private keys, local Codex configuration, dependencies, and capture logs are excluded. The subprocess uses a fresh home, workspace-write sandbox, disabled tool network access, and no approval escalation. It cannot perform actions that require approval. Changes stay in `.raytace/runs/<run-id>/workspace`; no merge or publication occurs. The local gateway limits requests to 1–20; execution stops after three minutes, cancellation, or a provider failure. Multiple local commands may occur within one model request.

A new model cannot replay opaque reasoning/item-reference state from a different model. Expired snapshots require a fresh capture. Full execution requires the local Codex CLI and OpenRouter mode. Mock tests validate transport, isolation, and limits; live model/tool compatibility still depends on the selected provider. Session limits are preserved because execution traffic uses its own gateway rather than appearing as a new captured user session.

### Model-generated explanations

“Generate explanations” makes one separate Responses request through OpenRouter using `RAYTACE_OPENROUTER_MODEL` (the configured default, not the replay model selector). The API key remains in the proxy. The request includes the selected action and up to 16,000 characters of earlier context excerpts; it has no tools and requests up to three distinct hypotheses. Returned source IDs and exact quotes are checked before display. Unsupported explanations are dropped rather than replaced with generic labels. These are hypotheses, not recovered reasoning or causal probabilities.

Results are cached under `.raytace/explanations` by model, action, and supplied excerpts and reused on reopening the step or restarting the proxy. Failed requests can be retried. Saved captures can be explained even after their replay snapshot expires. No explanation call occurs until the button is clicked.
