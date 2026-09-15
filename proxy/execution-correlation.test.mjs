import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarity, matchExecutionToCall, matchBatch, parseRolloutLine } from './execution-correlation.mjs';

// Real rollout line shape, trimmed to what parseRolloutLine actually reads
// (taken from the user's real ~/.codex session file, 2026-09-10).
const realRolloutLine = JSON.stringify({
  timestamp: '2026-09-10T13:13:07.712Z',
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    item: {
      type: 'CommandExecution',
      id: 'exec-819cfa0f-b714-464c-bba0-5cf05651cbcf',
      command: ['/bin/zsh', '-lc', "pwd; rg --files -g 'AGENTS.md' -g 'package.json'; git status --short"],
      cwd: `file://${process.cwd()}`,
      status: 'completed',
      exit_code: 0,
      duration: { secs: 0, nanos: 4625 },
    },
  },
});

test('parseRolloutLine extracts a completed CommandExecution', () => {
  const parsed = parseRolloutLine(realRolloutLine);
  assert.equal(parsed.id, 'exec-819cfa0f-b714-464c-bba0-5cf05651cbcf');
  assert.match(parsed.command, /pwd; rg --files/);
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.durationMs, 0); // 4625 nanoseconds rounds to 0ms
  assert.equal(parsed.error, null);
});

test('parseRolloutLine ignores non-CommandExecution and malformed lines', () => {
  assert.equal(parseRolloutLine('not json at all'), null);
  assert.equal(parseRolloutLine(JSON.stringify({ payload: { type: 'item_completed', item: { type: 'AgentMessage' } } })), null);
  assert.equal(parseRolloutLine(JSON.stringify({ payload: { type: 'turn_context' } })), null);
});

test('parseRolloutLine captures a failure', () => {
  const line = JSON.stringify({
    timestamp: '2026-09-10T13:14:00.000Z',
    payload: { type: 'item_completed', item: {
      type: 'CommandExecution', id: 'exec-2', command: ['/bin/zsh', '-lc', 'cat missing.txt'],
      status: 'failed', exit_code: 1, stderr: 'cat: missing.txt: No such file or directory', duration: { secs: 0, nanos: 100000 },
    } },
  });
  const parsed = parseRolloutLine(line);
  assert.equal(parsed.status, 'failed');
  assert.equal(parsed.exitCode, 1);
  assert.match(parsed.error, /No such file/);
});

test('similarity: identical command text scores 1.0 regardless of args shape', () => {
  const command = "rg -n 'cost|duration' app/request-metrics.tsx; cat proxy/request-metrics.mjs";
  assert.equal(similarity(command, { command }), 1);
  assert.equal(similarity(command, { cmd: command }), 1); // shape-agnostic — different key name
  assert.equal(similarity(command, command), 1); // bare string args
});

test('similarity: unrelated commands score low', () => {
  const score = similarity('ls -la proxy/', { command: 'npm install --save-dev vitest' });
  assert.ok(score < 0.3, `expected low similarity, got ${score}`);
});

test('matchExecutionToCall picks the real proposed call over an unrelated one in the same window', () => {
  const exec = { id: 'exec-1', command: "cat package.json; cat app/request-metrics.tsx", timestamp: 1_000_000 };
  const candidates = [
    { call_id: 'call_unrelated', timestamp: 1_000_500, args: { command: 'git status --short' } },
    { call_id: 'call_real', timestamp: 1_000_200, args: { command: 'cat package.json; cat app/request-metrics.tsx' } },
  ];
  const match = matchExecutionToCall(exec, candidates);
  assert.equal(match.call_id, 'call_real');
  assert.equal(match.basis, 'text');
});

test('matchExecutionToCall returns null when nothing in the window matches well', () => {
  const exec = { id: 'exec-1', command: 'rm -rf node_modules', timestamp: 1_000_000 };
  const candidates = [{ call_id: 'call_a', timestamp: 1_000_100, args: { command: 'ls -la' } }];
  assert.equal(matchExecutionToCall(exec, candidates), null);
});

test('matchExecutionToCall short-circuits on an exact id match (newer unified_exec Codex builds reuse call_id as the exec id)', () => {
  // No shared command text at all — if this matches, it can only be via the
  // exact-id path, not the fuzzy similarity fallback.
  const exec = { id: 'call_e04139dfcab54327affa0c75', command: 'ls -la proxy/', timestamp: 1_000_000 };
  const candidates = [
    { call_id: 'call_unrelated', timestamp: 1_000_050, args: { command: 'git status --short' } },
    { call_id: 'call_e04139dfcab54327affa0c75', timestamp: 1_000_400, args: { command: 'totally different args text' } },
  ];
  const match = matchExecutionToCall(exec, candidates);
  assert.equal(match.call_id, 'call_e04139dfcab54327affa0c75');
  assert.equal(match.score, 1);
  assert.equal(match.basis, 'id');
});

test('matchExecutionToCall prefers the exact id match over a higher-scoring text match on a different candidate', () => {
  const exec = { id: 'call_abc', command: 'npm test', timestamp: 1_000_000 };
  const candidates = [
    { call_id: 'call_abc', timestamp: 1_000_300, args: { command: 'unrelated text' } },
    { call_id: 'call_xyz', timestamp: 1_000_050, args: { command: 'npm test' } }, // would win on text score alone
  ];
  const match = matchExecutionToCall(exec, candidates);
  assert.equal(match.call_id, 'call_abc');
  assert.equal(match.basis, 'id');
});

test('matchExecutionToCall finds an exact id match even when it falls outside the time window (a queued/delayed command should not lose a certain match)', () => {
  const exec = { id: 'call_1cf2b295fbd94c239a29b2ff', command: 'find ~/.codex -type f -exec grep -l qwen {} \\;', timestamp: 1_000_000 };
  const candidates = [
    { call_id: 'call_1cf2b295fbd94c239a29b2ff', timestamp: 1_000_000 - 31_560, args: { cmd: 'find ~/.codex -type f -exec grep -l qwen {} \\;' } },
  ];
  const match = matchExecutionToCall(exec, candidates, { windowMs: 30_000 });
  assert.equal(match.call_id, 'call_1cf2b295fbd94c239a29b2ff');
  assert.equal(match.score, 1);
  assert.equal(match.basis, 'id');
});

test('matchExecutionToCall ignores candidates outside the time window', () => {
  const exec = { id: 'exec-1', command: 'ls -la', timestamp: 1_000_000 };
  const candidates = [{ call_id: 'call_far', timestamp: 1_000_000 + 60_000, args: { command: 'ls -la' } }];
  assert.equal(matchExecutionToCall(exec, candidates, { windowMs: 30_000 }), null);
});

test('matchBatch resolves duplicate identical commands in chronological order, one candidate each', () => {
  const execs = [
    { id: 'exec-1', command: 'ls -la', timestamp: 1_000_000 },
    { id: 'exec-2', command: 'ls -la', timestamp: 1_000_500 },
  ];
  const candidates = [
    { call_id: 'call_first', timestamp: 999_900, args: { command: 'ls -la' } },
    { call_id: 'call_second', timestamp: 1_000_400, args: { command: 'ls -la' } },
  ];
  const results = matchBatch(execs, candidates);
  assert.equal(results.get('exec-1').call_id, 'call_first'); // earliest exec claims closest-in-time first
  assert.equal(results.get('exec-2').call_id, 'call_second'); // second exec gets what's left, not a re-claim
});

test('matchBatch never assigns the same call_id to two executions', () => {
  const execs = [
    { id: 'exec-1', command: 'npm test', timestamp: 1_000_000 },
    { id: 'exec-2', command: 'npm test', timestamp: 1_000_100 },
    { id: 'exec-3', command: 'npm test', timestamp: 1_000_200 },
  ];
  const candidates = [{ call_id: 'call_only_one', timestamp: 1_000_050, args: { command: 'npm test' } }];
  const results = matchBatch(execs, candidates);
  assert.equal(results.size, 1); // only one candidate existed; the other two executions stay unmatched
});
