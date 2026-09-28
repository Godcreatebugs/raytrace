import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarity, matchExecutionToCall, matchBatch } from './execution-correlation.mjs';

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

// Causal windows: a sandbox call can only have run after the request that
// proposed it started, and before the agent sent its result back.
const RM = { command: 'rm notes.md' };
const causal = (call_id, window_start, window_end = null) => ({ call_id, timestamp: window_start, args: RM, window_start, window_end });

test('causal window: a retried proposal cannot claim a run from before it existed, and vice versa', () => {
  // call_a proposed at 0, result sent at 5 s; call_b (the retry) proposed at 10 s, still pending.
  const candidates = [causal('call_a', 0, 5_000), causal('call_b', 10_000)];
  assert.deepEqual(matchExecutionToCall({ command: '/bin/bash -lc rm notes.md', timestamp: 12_000, margin: 250 }, candidates),
    { call_id: 'call_b', score: 1, basis: 'window', window_start: 10_000, window_end: null });
  assert.equal(matchExecutionToCall({ command: 'rm notes.md', timestamp: 3_000, margin: 250 }, candidates).call_id, 'call_a');
});

test('causal window: a slow command still matches 45 s after its proposal (the old +-30 s window missed it)', () => {
  const exec = { command: 'rm notes.md', timestamp: 45_000, margin: 250 };
  assert.equal(matchExecutionToCall(exec, [causal('call_a', 0)])?.call_id, 'call_a');
  assert.equal(matchExecutionToCall(exec, [{ call_id: 'call_a', timestamp: 0, args: RM }]), null, 'legacy candidates keep the old window');
});

test('causal window: a run that starts after the result was sent is not that call', () => {
  assert.equal(matchExecutionToCall({ command: 'rm notes.md', timestamp: 8_000, margin: 250 }, [causal('call_a', 0, 5_000)]), null);
  // ...but clock margin still absorbs measured skew at the edges.
  assert.equal(matchExecutionToCall({ command: 'rm notes.md', timestamp: 5_200, margin: 250 }, [causal('call_a', 0, 5_000)])?.call_id, 'call_a');
  assert.equal(matchExecutionToCall({ command: 'rm notes.md', timestamp: -200, margin: 250 }, [causal('call_a', 0, 5_000)])?.call_id, 'call_a');
});

test('causal window: a call that never reported back stops competing after the open-window cap', () => {
  assert.equal(matchExecutionToCall({ command: 'rm notes.md', timestamp: 11 * 60_000, margin: 250 }, [causal('call_a', 0)]), null);
});

test('causal window: text is still required inside the window (agent helpers run while a call is pending)', () => {
  assert.equal(matchExecutionToCall({ command: 'git status --short', timestamp: 1_000, margin: 250 }, [causal('call_a', 0)]), null);
});

test('causal window: two pending look-alikes resolve to the most recently opened one', () => {
  const candidates = [causal('call_old', 0), causal('call_new', 20_000)];
  assert.equal(matchExecutionToCall({ command: 'rm notes.md', timestamp: 21_000, margin: 250 }, candidates).call_id, 'call_new');
});

test('causal window: a window match carries the bounds that justified it', () => {
  assert.deepEqual(matchExecutionToCall({ command: 'rm notes.md', timestamp: 3_000, margin: 250 }, [causal('call_a', 0, 5_000)]),
    { call_id: 'call_a', score: 1, basis: 'window', window_start: 0, window_end: 5_000 });
  // A legacy text match carries none.
  assert.deepEqual(matchExecutionToCall({ command: 'rm notes.md', timestamp: 3_000 }, [{ call_id: 'call_a', timestamp: 0, args: RM }]),
    { call_id: 'call_a', score: 1, basis: 'text' });
});
