import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { providerConfig } from './providers.mjs';
import { codexArgs } from './codex-config.mjs';
import { log, LAUNCHER_LOG_PATH } from './launcher-log.mjs';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = providerConfig();
const port = process.env.RAYTACE_PORT || '8797';

// OFF BY DEFAULT. Runs Codex's whole process tree inside a Docker container
// instead of directly on this machine, so its shell commands can only touch
// whatever is explicitly bind-mounted in (the project directory, below), not
// your whole home directory. This captures model traffic only: observed
// execution evidence comes from the gVisor sandbox (npm run dev:all), not
// from this mode. Opt in with RAYTACE_CONTAINER=1; leave unset to run Codex
// natively.
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

let child;
if (useContainer) {
  const image = process.env.RAYTACE_CODEX_IMAGE || 'raytace-codex';
  // CODEX_HOME (usually ~/.codex) holds your existing Codex login/session --
  // bind-mounted in so a containerized run reuses it instead of needing to
  // log in again inside the container every time.
  const codexHome = process.env.CODEX_HOME || `${homedir()}/.codex`;
  log(`[raytace] RAYTACE_CONTAINER=1 -- launching Codex in Docker (image: ${image}). Diagnostics also written to ${LAUNCHER_LOG_PATH} -- tail that file in another terminal, since Codex's own TUI hides anything printed to this one once it starts.`);
  child = spawn('docker', [
    'run', '-it', '--rm',
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

child.on('error', (error) => { console.error(`Could not launch Codex: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
