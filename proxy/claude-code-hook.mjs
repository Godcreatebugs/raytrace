#!/usr/bin/env node
/**
 * Claude Code hook: tells RayTrace a session's transcript has new lines.
 * Claude Code runs this on each hook event with the event JSON on stdin; only
 * the session id, transcript path and event name are forwarded -- RayTrace
 * reads the transcript itself. Always exits 0 with no output, fast, so a
 * stopped RayTrace never slows or blocks Claude Code.
 */
const port = process.env.RAYTACE_PORT || '8797';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  await fetch(`http://127.0.0.1:${port}/raytace/ingest/claude-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-raytace-hook': '1' },
    body: JSON.stringify({ session_id: event.session_id, transcript_path: event.transcript_path, hook_event_name: event.hook_event_name }),
    signal: AbortSignal.timeout(800),
  });
} catch { /* RayTrace not running, or a malformed event: stay silent */ }
