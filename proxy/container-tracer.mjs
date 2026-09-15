/**
 * Starts a sidecar Docker container that runs bpftrace scoped to the
 * Codex workload container's own cgroup (see docker/tracer/), parses its
 * EXEC/EXIT lines, batches confirmed exec events, and POSTs them to the
 * proxy -- the container-native replacement for the old macOS eslogger
 * tailer (see proxy/raytace-execution-reporting.md project doc for that
 * history: eslogger was retired for being an unfilterable, whole-machine
 * firehose that Apple itself says isn't meant for programmatic use).
 *
 * Why this needs no ProcessTree/pid-reuse bookkeeping the way eslogger did:
 * the bpftrace script (docker/tracer/entrypoint.sh) filters by the target
 * container's cgroup *in the kernel*, before anything is even printed. A
 * cgroup is a kernel-wide unique scope -- if the Codex container is the
 * only thing running in it, every EXEC line this tracer ever prints is
 * already known to belong to Codex's own process tree. No scoping logic
 * needed downstream.
 *
 * Timestamps are assigned in Node on receipt (Date.now()), not read from
 * the kernel event itself -- bpftrace's own clock is boot-relative
 * (`nsecs`), not wall-clock, and the ±30s match window used by matchBatch
 * already tolerates the small delay between the kernel event and this
 * process reading its line.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { log } from './launcher-log.mjs';

/** Parses one line of the tracer sidecar's stdout into a normalized event,
 * or null for anything that isn't a well-formed EXEC/EXIT line (including
 * the sidecar's own `[tracer] ...` diagnostic lines on stderr -- callers
 * should only ever feed this stdout, but it's defensive here too). */
export function parseTracerLine(line, now = Date.now) {
  if (typeof line !== 'string') return null;
  const parts = line.split('\t');
  if (parts[0] === 'EXEC' && parts.length >= 3) {
    const pid = Number(parts[1]);
    const command = parts.slice(2).join('\t').trim();
    if (!Number.isFinite(pid) || !command) return null;
    return { kind: 'exec', pid, command, timestamp: now() };
  }
  if (parts[0] === 'EXIT' && parts.length === 2) {
    const pid = Number(parts[1]);
    if (!Number.isFinite(pid)) return null;
    return { kind: 'exit', pid };
  }
  return null;
}

/**
 * Starts `docker run --rm --privileged ... <tracerImage> <containerId>`,
 * batches EXEC events every ~1.5s, and POSTs them to
 * `${proxyBase}/raytace/kernel-executions`. Best-effort throughout, same
 * stance as the eslogger tailer it replaces: a container/bpftrace failure
 * (missing image, container already exited, kernel too old for BTF, etc.)
 * is printed via this process's own stderr, prefixed `[raytace][tracer]`,
 * and simply means no kernel confirmation for this session -- it never
 * touches Codex's own container or exit code.
 */
export function startContainerTracer({ containerId, proxyBase, tracerImage = process.env.RAYTACE_TRACER_IMAGE || 'raytace-tracer', windowMs = 30_000 }) {
  // Kept as a rolling window, not a queue that's drained on every flush:
  // the kernel sees a command at syscall *entry*, but Codex's rollout log
  // (what the proxy actually matches against) only gets a row once the
  // command *finishes* -- so the very first flush after a fast command is
  // captured can easily run before that row exists yet. Re-sending each
  // event on every flush until it ages out of the proxy's own ±30s match
  // window (see WINDOW_MS in raytace-proxy.mjs) gives the rollout side time
  // to catch up instead of getting exactly one, often-too-early attempt.
  // Re-sending is safe: db.confirmKernelExecution is an idempotent UPDATE,
  // so matching (or re-matching) the same event twice is a no-op the
  // second time, not a duplicate row or a double-count.
  let recent = [];
  let stopped = false;

  const flush = async () => {
    const now = Date.now();
    recent = recent.filter((e) => now - e.addedAt <= windowMs);
    if (!recent.length) return;
    const events = recent.map(({ command, timestamp, pid }) => ({ command, timestamp, pid }));
    try {
      const res = await fetch(`${proxyBase}/raytace/kernel-executions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-raytace-experiment': '1' }, body: JSON.stringify({ events }),
      });
      const body = await res.json().catch(() => null);
      if (body && Number.isFinite(body.confirmed) && Number.isFinite(body.total)) {
        log(`[raytace][tracer] batch: ${body.confirmed}/${body.total} confirmed (${recent.length} in this window)`);
      } else {
        log(`[raytace][tracer] batch POST returned ${res.status} with unexpected body: ${JSON.stringify(body)}`);
      }
    } catch (error) {
      // Best-effort -- a dropped batch of kernel confirmations just means
      // those rows stay unconfirmed-by-kernel, never wrongly confirmed.
      log(`[raytace][tracer] batch POST failed: ${error.message}`);
    }
  };
  const interval = setInterval(flush, 1500);

  log(`[raytace][tracer] starting sidecar for container ${containerId}`);
  const child = spawn('docker', [
    'run', '--rm', '--privileged',
    '-v', '/sys/fs/cgroup:/sys/fs/cgroup:ro',
    '-v', '/sys/kernel/debug:/sys/kernel/debug:ro',
    tracerImage, containerId,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const outLines = createInterface({ input: child.stdout });
  outLines.on('line', (line) => {
    const parsed = parseTracerLine(line);
    if (!parsed || parsed.kind !== 'exec') return;
    recent.push({ command: parsed.command, timestamp: parsed.timestamp, pid: parsed.pid, addedAt: Date.now() });
    log(`[raytace][tracer] candidate exec pid=${parsed.pid}: ${parsed.command.slice(0, 80)}`);
  });
  // The sidecar's own stderr carries its cgroup-discovery progress and any
  // bpftrace errors -- surfaced directly since RAYTACE_CONTAINER=1 is an
  // explicit opt-in, so a real failure here should be visible, not
  // indistinguishable from working.
  const errLines = createInterface({ input: child.stderr });
  errLines.on('line', (line) => log(`[raytace][tracer] ${line}`));
  child.on('error', (error) => log(`[raytace][tracer] failed to start: ${error.message}`));
  child.on('exit', (code, signal) => {
    if (stopped) return;
    log(`[raytace][tracer] exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}) -- kernel verification stopped for the rest of this session.`);
  });

  return () => {
    stopped = true;
    clearInterval(interval);
    void flush();
    child.kill();
  };
}
