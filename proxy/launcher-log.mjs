/**
 * Codex's own interactive session takes over the terminal with a
 * full-screen TUI (an alternate screen buffer, the same mechanism vim/htop
 * use) -- since codex.mjs launches it with stdio: 'inherit', anything this
 * launcher (or the tracer sidecar) prints to that same terminal is either
 * invisible while Codex is running or only reappears once you quit it.
 * That makes `[raytace][tracer] ...` diagnostics effectively useless for
 * debugging a live session.
 *
 * This logs to stderr as before (harmless, sometimes visible) AND appends
 * to a persistent file, so `tail -f .raytace/launcher.log` in a second
 * terminal always shows what's happening regardless of what's on screen in
 * the Codex session itself.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DIR = process.env.RAYTACE_DATA_DIR || '.raytace';
const LOG_PATH = join(LOG_DIR, 'launcher.log');

export function log(message) {
  try { console.error(message); } catch { /* stderr gone -- ignore */ }
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Best-effort logging must never be why the launcher crashes.
  }
}

export const LAUNCHER_LOG_PATH = LOG_PATH;
