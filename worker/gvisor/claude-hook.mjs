#!/usr/bin/env node
/**
 * Claude Code hook inside a RayTrace sandbox. projects.py enable-claude
 * installs it root-owned with a managed-settings file, so the agent can
 * neither edit nor turn it off.
 *
 * PreToolUse (Bash): starts the command with `export RAYTRACE_CALL_ID=<the
 * tool call's id>`. The shell carries the id in its argv and every program it
 * starts carries it in its environment, where the gVisor collector reads it
 * (collector.py MARKER_KEYS): the evidence joins the call exactly instead of
 * by command text.
 *
 * Every other event: sends the transcript's new whole lines to RayTrace
 * through the sandbox manager -- the only host service this sandbox can
 * reach -- with the sandbox's proxy token. How far it got is kept in /tmp; if
 * that is lost, RayTrace answers 409 with the size of its copy and sending
 * resumes from there.
 *
 * Never blocks or fails Claude Code: RayTrace being down means no capture.
 */
import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const BROKER = 'http://192.168.5.2:8799/raytace/ingest/claude-code';
const CHUNK = 3 * 1024 * 1024; // under the manager's 4 MiB request limit
const home = process.env.HOME || '/home/node';

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }

if (input.hook_event_name === 'PreToolUse') {
  const id = input.tool_use_id;
  const command = input.tool_input?.command;
  if (input.tool_name === 'Bash' && /^[A-Za-z0-9_-]{1,128}$/.test(id ?? '') && typeof command === 'string') {
    // An input change needs a decision with it. Only a session that already
    // skips permission prompts gets "allow"; any other still asks as usual.
    const decision = input.permission_mode === 'bypassPermissions' ? 'allow' : 'ask';
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision,
      updatedInput: { ...input.tool_input, command: `export RAYTRACE_CALL_ID=${id}\n${command}` } } }));
  }
  process.exit(0);
}

const session = input.session_id;
const transcript = input.transcript_path;
if (!/^[0-9a-f-]{36}$/.test(session ?? '') || typeof transcript !== 'string'
  || !transcript.startsWith(join(home, '.claude', 'projects') + '/')) process.exit(0);

try {
  // The token approve-proxy gave this sandbox, from its Codex config.
  const config = readFileSync(join(home, '.raytace-codex', 'config.toml'), 'utf8');
  const token = /"x-raytace-sandbox-token"\s*=\s*"([^"]+)"/.exec(config)?.[1];
  if (!token) process.exit(0);
  const stateDir = '/tmp/raytace-claude';
  const stateFile = join(stateDir, `${session}.offset`);
  let offset = 0;
  try { offset = Number(readFileSync(stateFile, 'utf8')) || 0; } catch { /* first send, or /tmp was cleared */ }

  for (let attempt = 0; attempt < 8; attempt++) {
    const fd = openSync(transcript, 'r');
    let text = '';
    let more = false;
    try {
      const available = fstatSync(fd).size - offset;
      if (available > 0) {
        const buffer = Buffer.alloc(Math.min(available, CHUNK));
        readSync(fd, buffer, 0, buffer.length, offset);
        const whole = buffer.lastIndexOf(10) + 1; // the last line may still be being written
        text = buffer.subarray(0, whole).toString('utf8');
        more = available > CHUNK && whole > 0;
      }
    } finally { closeSync(fd); }
    const response = await fetch(BROKER, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raytace-sandbox-token': token },
      body: JSON.stringify({ session_id: session, hook_event_name: input.hook_event_name, offset, text }),
      signal: AbortSignal.timeout(4000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && Number.isInteger(body.size)) { offset = body.size; continue; }
    if (!response.ok || !Number.isInteger(body.size)) break;
    offset = body.size;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(stateFile, String(offset));
    if (!more) break;
  }
} catch { /* RayTrace or the manager not running: stay silent */ }
