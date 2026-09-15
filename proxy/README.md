# RayTrace capture proxy

Run `npm run proxy`. Set a compatible client base URL to `http://127.0.0.1:8797`; exchanges are forwarded to OpenAI or Anthropic and appended to `.raytace/events.jsonl`.

Port 8797 is the default (moved off 8787 because another local tool was using it). Set `RAYTACE_PORT` in `.env` to change the port for both the proxy and Codex launcher.

Configure alternate endpoints with `RAYTACE_OPENAI_UPSTREAM` and `RAYTACE_ANTHROPIC_UPSTREAM`. JSON fields resembling credentials are redacted before storage. Production needs encrypted storage, stronger DLP rules, authenticated ingestion, and an object store for streaming payloads.

## Storage

Captures are stored in SQLite at `.raytace/raytace.db`, created automatically on
first run. There is nothing to install and no service to start: the database
engine is `node:sqlite`, built into Node 22, so `npm install && npm run proxy`
remains the whole setup.

Large payloads are content-addressed. An agent resends its entire history and
tool schema on every turn, so context items are hashed and stored once, then
referenced by each request that included them. On a real 842-exchange capture
this took the store from 83.6 MB of JSONL to 26.3 MB, with 14,651 context-item
positions resolving to 1,291 distinct texts. Loading the live dashboard went
from a 664 ms full-file scan on every poll to a 29 ms indexed query, and looking
up a single step from that same full scan to 6 ms.

Migrating an existing capture is one command:

```
npm run backfill
```

It streams `.raytace/events.jsonl` into the database and leaves the original
file untouched as a cold archive. It is idempotent — rows are replaced by
`span_id`, so re-running it never duplicates anything. Once it succeeds the
proxy no longer reads or writes the JSONL file; set `RAYTACE_ARCHIVE_JSONL=1`
to keep appending to it as well.

`RAYTACE_DB` overrides the database path. Schema changes are numbered files in
`proxy/migrations/`, applied once at startup and tracked with `PRAGMA
user_version`. Write-ahead logging is enabled where the filesystem supports it,
which lets the dashboard read while the proxy writes; on network or sync-folder
mounts that cannot provide it, the store falls back to a rollback journal rather
than refusing to start. The startup banner reports which mode is in use.

Proposed tool calls are recorded in `tool_calls` as they are captured. The
`tool_executions` table is written by the (not yet built) execution reporting
path; until then a proposed call with no matching execution row reports as
`not_executed`, which is the intended signal rather than missing data.

## Optional OpenRouter routing

Copy `.env.example` to `.env` and put your OpenRouter key in `OPENROUTER_API_KEY`. The proxy and launcher load this file automatically from the project root; `.env` is ignored by Git.

```dotenv
RAYTACE_PROVIDER=openrouter
OPENROUTER_API_KEY=your-key-here
RAYTACE_OPENROUTER_MODEL=coder
```

Run `npm run proxy` in one terminal, then `npm run codex` in another. The launcher uses a temporary Codex provider pointed at RayTrace and leaves your saved Codex settings untouched. Additional CLI arguments work, for example `npm run codex -- --model deepseek`.

### Containerized Codex + kernel-level execution verification (opt-in)

Set `RAYTACE_CONTAINER=1` before `npm run codex` to run Codex's entire process inside a Docker container instead of directly on this machine, and to get an independent, kernel-level cross-check of what actually ran:

```
npm run docker:build     # once, or whenever docker/ changes
RAYTACE_CONTAINER=1 npm run codex
```

Two things this buys you: Codex's shell commands can only touch what's explicitly bind-mounted in (your project directory and `CODEX_HOME`, not your whole home directory), and a second Docker container runs `bpftrace` scoped to the Codex container's own cgroup, watching its exec/exit activity straight from the kernel -- see `proxy/container-tracer.mjs`. A confirmed row shows up as `kernel_confirmed = 1` on the same `tool_executions` row the rollout tailer already wrote (see `proxy/migrations/004_kernel_verification.sql`), never a second, competing row.

This replaces an earlier macOS-only approach built on `eslogger`, which turned out to be an unfilterable, whole-machine firehose with a real, measured CPU/IO cost, and which Apple's own docs say isn't meant for programmatic use. Scoping by container cgroup instead of by a hand-maintained process tree fixes both problems at once, and the same approach works on Linux and (via Docker Desktop) Windows, not just macOS.

**Known rough edges, since this hasn't been run end-to-end yet:**
- `docker/codex/Dockerfile` assumes Codex installs via `npm install -g @openai/codex`. If that's not how you installed it locally, edit that line before building.
- The tracer sidecar runs `--privileged`. That's a real capability grant on your machine, scoped to a container that only runs `bpftrace` for the duration of your Codex session -- narrower capability flags (`--cap-add=BPF`, etc.) are a possible follow-up once this is confirmed working, but privileged is the safer starting point given kernel/BTF version differences aren't something we could test in advance.
- `RAYTACE_PROVIDER=native` (i.e. not routing through OpenRouter) is untested in container mode: Codex's own `~/.codex/config.toml` may point at `127.0.0.1`, which won't resolve to this Mac from inside the container. OpenRouter mode (the default path documented above) rewrites the base URL automatically and doesn't have this problem.


### gVisor sandbox sessions: per-call verdicts from the sandbox's own evidence

Sessions started through the gVisor sandbox (`npm run sandbox:*`, see `worker/gvisor/README.md`) can't use either of the witnesses above: Codex's rollout log lives in a memory-backed `CODEX_HOME` inside the sandbox that this Mac can't read, and the bpftrace sidecar only *confirms* rows the rollout tailer already wrote. For those sessions the proxy runs a forwarder (`proxy/gvisor-forwarder.mjs`) that makes gVisor the **primary** witness instead:

1. It asks the sandbox manager (`npm run sandbox:manager`, `:8799/api/projects`) which `rtp-…` sandbox ids map to which container ids.
2. It tails each container's `exec_succeeded` / `process_exit` events from the evidence viewer (`:8798/events?after=<cursor>`, port-forwarded out of the Lima VM).
3. Each *top-level* exec (Codex's `/bin/bash -lc <cmd>` wrapper; children of an already-matched command are skipped) goes through the same `matchBatch()` matcher as the rollout tailer, scoped to that sandbox's session id only, and lands in `tool_executions` with `source = 'gvisor'`, `status = 'running'`, and `kernel_confirmed = 1`.
4. The matching `process_exit` closes the row with the real exit code (`completed`, or `failed` with `exit N` / `killed by signal N`).

On the dashboard this shows as a **Sandbox-verified** badge (or **Sandbox: running** until the exit arrives) on the Decision Chain, alongside the existing raw "Independent sandbox execution evidence" timeline. Nothing about the matching is looser than before: an exec that doesn't clear the same similarity bar stays `not_executed`, and a wrong match is still the failure mode this is tuned against.

The forwarder is on by default and best-effort: with no manager or VM running it logs one line and idles. `RAYTACE_GVISOR_FORWARDER=0` disables it; `RAYTACE_SANDBOX_MANAGER` / `RAYTACE_EVIDENCE_VIEWER` override the two base URLs. After changing `worker/gvisor/viewer.py` (it gained the `after` cursor for this), push it into the VM without a full re-setup:

```
limactl copy worker/gvisor/viewer.py raytace-gvisor:/tmp/viewer.py
limactl shell raytace-gvisor sudo cp /tmp/viewer.py /opt/raytace/viewer.py
limactl shell raytace-gvisor sudo systemctl restart raytace-viewer
```


The OpenRouter launcher labels each new Codex launch as a separate session. Once its first response is captured, the dashboard shows the latest session only and switches away from older prompts automatically. The Compare runs picker loads the most recent 100 saved runs across all sessions, including older captures without session tracking. The main timeline remains scoped to the latest session. Restarting the dashboard does not delete captures. Older sessions remain in `.raytace/events.jsonl`; captures made before session tracking stay hidden. Clients without session headers are grouped by proxy run, so restart the proxy to start a fresh group for those clients.

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
