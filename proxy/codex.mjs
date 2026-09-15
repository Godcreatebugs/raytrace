import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { providerConfig } from './providers.mjs';
import { codexArgs } from './codex-config.mjs';
import { startExecutionTailer } from './execution-tailer.mjs';
import { startContainerTracer } from './container-tracer.mjs';
import { log, LAUNCHER_LOG_PATH } from './launcher-log.mjs';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = providerConfig();
const port = process.env.RAYTACE_PORT || '8797';

// OFF BY DEFAULT. Runs Codex's whole process tree inside a Docker container
// instead of directly on this machine. Two independent reasons to opt in:
//   1. Kernel-level execution verification (see proxy/container-tracer.mjs)
//      needs a scope narrower than "everything on this machine" -- a
//      container's cgroup gives that for free, which is what let us retire
//      macOS's eslogger (an unfilterable, whole-machine firehose Apple's own
//      docs say isn't meant for programmatic use -- see
//      raytace-execution-reporting.md project doc for that history).
//   2. Real sandboxing: Codex's shell commands can only touch whatever is
//      explicitly bind-mounted in (the project directory, below), not your
//      whole home directory.
// Opt in with RAYTACE_CONTAINER=1; leave unset to run Codex natively exactly
// as before.
const useContainer = process.env.RAYTACE_CONTAINER === '1';

// From inside the container, RayTrace's proxy on this Mac is reached via
// Docker Desktop's host.docker.internal, not 127.0.0.1 -- the container has
// its own network namespace. Native runs are unaffected (still 127.0.0.1).
const codexHost = useContainer ? 'host.docker.internal' : '127.0.0.1';
const rawArgs = process.argv.slice(2);
const args = codexArgs(config, rawArgs, port, codexHost);

// Codex ships its own internal sandbox (bubblewrap on Linux) for the shell
// commands it runs, which itself needs to create a Linux user namespace --
// something Docker blocks by default (`bwrap: No permissions to create a
// new namespace`), and asking the container for that capability just to
// satisfy a sandbox we don't need would be self-defeating: the Docker
// container this whole file exists to launch (see the block above) IS the
// sandbox for this run. So in container mode only, tell Codex to skip its
// own -- unless you've already asked for a specific sandbox policy on the
// command line, in which case that's left alone.
const hasOwnSandboxFlag = rawArgs.some((a) =>
  a === '-s' || a === '--sandbox' || a.startsWith('--sandbox=') || a === '--dangerously-bypass-approvals-and-sandbox');
const containerSandboxArgs = useContainer && !hasOwnSandboxFlag ? ['--sandbox', 'danger-full-access'] : [];

const spawnedAtMs = Date.now();

let child;
let cidFile;
if (useContainer) {
  const image = process.env.RAYTACE_CODEX_IMAGE || 'raytace-codex';
  // CODEX_HOME (usually ~/.codex) holds your existing Codex login/session --
  // bind-mounted in so a containerized run reuses it instead of needing to
  // log in again inside the container every time.
  const codexHome = process.env.CODEX_HOME || `${homedir()}/.codex`;
  cidFile = join(mkdtempSync(join(tmpdir(), 'raytace-cid-')), 'cid');
  log(`[raytace] RAYTACE_CONTAINER=1 -- launching Codex in Docker (image: ${image}). Diagnostics also written to ${LAUNCHER_LOG_PATH} -- tail that file in another terminal, since Codex's own TUI hides anything printed to this one once it starts.`);
  child = spawn('docker', [
    'run', '-it', '--rm',
    '--cidfile', cidFile,
    // no-op on Docker Desktop for Mac (host.docker.internal already resolves
    // there); required on native Linux Docker Engine, kept for portability.
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${process.cwd()}:/workspace`,
    '-v', `${codexHome}:/root/.codex`,
    '-w', '/workspace',
    image,
    'codex', ...containerSandboxArgs, ...args,
  ], { stdio: 'inherit' });
} else {
  child = spawn('codex', args, { stdio: 'inherit' });
}

// Best-effort: tails Codex's own rollout log for this session and forwards
// real CommandExecution events to the proxy, so RayTrace can eventually show
// what actually ran (not just what the model proposed) instead of always
// falling back to "not_executed". Never touches the interactive session
// itself — stdio stays 'inherit' above, unchanged; this runs alongside it.
// Reads from CODEX_HOME on THIS machine either way: in container mode that
// directory is bind-mounted into the container, so Codex's rollout log
// lands in the same place on disk regardless of which mode launched it. See
// proxy/execution-tailer.mjs and proxy/execution-correlation.mjs for why
// this can't be a simple ID lookup, and proxy/raytace-storage-layer.md
// (project docs) for the full design writeup.
const stopTailer = startExecutionTailer({
  codexHome: process.env.CODEX_HOME || `${homedir()}/.codex`,
  proxyBase: `http://127.0.0.1:${port}`,
  spawnedAtMs,
});

// Second, independent witness alongside the rollout-log tailer above: a
// cgroup-scoped bpftrace sidecar (docker/tracer/) watching the Codex
// container's own process tree at the kernel level, cross-confirming rows
// the tailer above already wrote rather than trusting Codex's own account of
// itself alone. Only meaningful in container mode -- there is no container
// cgroup to scope to when Codex runs natively. See
// proxy/container-tracer.mjs for the full design and
// proxy/migrations/004_kernel_verification.sql for the schema.
let stopTracer = () => {};
if (useContainer) {
  waitForCidFile(cidFile)
    .then((containerId) => {
      stopTracer = startContainerTracer({ containerId, proxyBase: `http://127.0.0.1:${port}` });
    })
    .catch((error) => log(`[raytace] could not start kernel tracer: ${error.message}`));
}

async function waitForCidFile(path, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      const id = readFileSync(path, 'utf8').trim();
      if (id) return id;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for the Codex container id (${path})`);
}

child.on('error', (error) => { console.error(`Could not launch Codex: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { stopTailer(); stopTracer(); if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
