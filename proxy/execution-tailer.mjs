/**
 * Finds and incrementally reads Codex's own rollout log for the session
 * `codex.mjs` just spawned, so real CommandExecution events can be forwarded
 * to the proxy's /raytace/executions endpoint for correlation.
 *
 * This is best-effort instrumentation riding alongside an interactive
 * session the user is actively watching (stdio: 'inherit') — it must never
 * be able to crash or visibly disrupt that session. Every export here is
 * defensive: a missing directory, a file that hasn't appeared yet, a
 * half-written trailing line — all treated as "nothing to report yet",
 * never thrown.
 *
 * The two pure-ish helpers (findLatestSessionFile, readNewLines) are kept
 * separate from the live orchestration (startExecutionTailer) specifically
 * so they can be unit-tested against a real temp directory/file without
 * needing to fake timers or spawn a process.
 */
import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRolloutLine } from './execution-correlation.mjs';
import { log } from './launcher-log.mjs';

/** Codex's rollout log path convention: $CODEX_HOME/sessions/<Y>/<M>/<D>/*.jsonl,
 * one file per session, named after when the session started. We don't know
 * the session's generated ID ahead of time, so this looks for whichever
 * .jsonl file in today's (or yesterday's, for sessions spanning midnight)
 * folder has a birth/modify time at or after `sinceMs` — i.e. the one Codex
 * just created for the process we spawned. */
export async function findLatestSessionFile(codexHome, sinceMs, { now = Date.now() } = {}) {
  const candidates = [];
  for (const dayOffset of [0, -1]) { // today, then yesterday (session started just before midnight)
    const d = new Date(now + dayOffset * 86_400_000);
    const dir = join(codexHome, 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
    let entries;
    try { entries = await readdir(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = join(dir, name);
      let info;
      try { info = await stat(full); } catch { continue; }
      if (info.mtimeMs >= sinceMs - 2000) candidates.push({ path: full, mtimeMs: info.mtimeMs }); // small slack for clock skew
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].path;
}

/** Reads whatever bytes have been appended to `path` since `offset`, and
 * returns fully-formed lines only — a trailing partial line (the file is
 * being written concurrently) is held back and re-read next time rather than
 * parsed prematurely. Returns { lines: string[], offset: number } — pass the
 * returned offset back in on the next call. */
export async function readNewLines(path, offset = 0) {
  let handle;
  try { handle = await open(path, 'r'); }
  catch { return { lines: [], offset }; } // file not there (yet, or race with rotation) — try again later
  try {
    const info = await handle.stat();
    if (info.size <= offset) return { lines: [], offset };
    const length = info.size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return { lines: [], offset }; // no complete line yet
    const complete = text.slice(0, lastNewline);
    const consumedBytes = Buffer.byteLength(complete, 'utf8') + 1; // + the newline itself
    return { lines: complete.split('\n').filter(Boolean), offset: offset + consumedBytes };
  } finally { await handle.close(); }
}

/**
 * Starts tailing the session's rollout log and forwarding parsed
 * CommandExecution events to the proxy in small batches. Returns a stop()
 * function; call it when the spawned Codex process exits.
 *
 * @param {{codexHome: string, proxyBase: string, spawnedAtMs: number}} options
 */
export function startExecutionTailer({ codexHome, proxyBase, spawnedAtMs }) {
  let stopped = false;
  let filePath = null;
  let offset = 0;
  let pending = [];
  let searchAttempts = 0;
  let loggedNotFound = false;

  async function flush() {
    if (!pending.length) return;
    const events = pending;
    pending = [];
    try {
      const res = await fetch(`${proxyBase}/raytace/executions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-raytace-experiment': '1' },
        body: JSON.stringify({ events }),
      });
      const body = await res.json().catch(() => null);
      log(`[raytace][rollout] sent ${events.length} event(s) -- ${res.status}${body ? ' ' + JSON.stringify(body) : ''}`);
    } catch (error) {
      // Best-effort: a dropped batch just means those rows stay
      // "not_executed" (today's existing default), not a corrupted or
      // crashed session. Never surfaced to the user mid-session. Still
      // logged to file (never to the inherited terminal via console.error)
      // since this is otherwise silent-by-design and hard to debug.
      log(`[raytace][rollout] batch POST failed: ${error.message}`);
    }
  }

  async function tick() {
    if (stopped) return;
    try {
      if (!filePath) {
        filePath = await findLatestSessionFile(codexHome, spawnedAtMs);
        searchAttempts += 1;
        if (filePath) log(`[raytace][rollout] tailing session file: ${filePath}`);
        else if (searchAttempts === 10 && !loggedNotFound) {
          // ~15s of polling (interval is 1.5s) with nothing found yet --
          // log once so a real miss (wrong codexHome, unexpected session
          // directory layout, etc.) doesn't look identical to "just
          // hasn't started yet" forever.
          loggedNotFound = true;
          log(`[raytace][rollout] still no session file found under ${codexHome}/sessions after ${searchAttempts} attempts (spawnedAtMs=${spawnedAtMs})`);
        }
      }
      if (filePath) {
        const result = await readNewLines(filePath, offset);
        offset = result.offset;
        for (const line of result.lines) {
          const parsed = parseRolloutLine(line);
          if (parsed && parsed.timestamp !== null) pending.push(parsed);
        }
        await flush();
      }
    } catch (error) {
      // Swallow everything here too — this loop must survive indefinitely
      // alongside a live interactive session. Logged, not thrown.
      log(`[raytace][rollout] tick failed: ${error.message}`);
    }
  }

  const interval = setInterval(tick, 1500);
  interval.unref?.(); // never keeps the process alive on its own

  return function stop() {
    stopped = true;
    clearInterval(interval);
    void flush(); // best-effort final flush; not awaited so exit isn't delayed
  };
}
