import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, describeCommand, describeAll, undescribed, bareCommand, isPreamble, describeRequest, parseDescriptions } from './exec-narrative.mjs';

const NS = (ms) => String(BigInt(ms) * 1_000_000n);
const exec = (event_id, pid, ppid, argv, ms = 1_700_000_000_000 + event_id) =>
  ({ event_id, kind: 'exec_succeeded', pid, ppid, argv, timestamp_ns: NS(ms) });
const exit = (event_id, pid, exit_code, ms = 1_700_000_000_000 + event_id) =>
  ({ event_id, kind: 'process_exit', pid, exit_code, signal: null, timestamp_ns: NS(ms) });

// The real preamble from the sandbox, shortened: Codex snapshots ~30 env vars
// around every command, which measured 16,027 characters on a live run.
const PREAMBLE = ['/bin/bash', '-c', '__CODEX_SNAPSHOT_OVERRIDE_SET_0="${CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS+x}"; __CODEX_SNAPSHOT_PROXY_OVERRIDE_0="${ALL_PROXY-}"'];

test('the Codex env preamble is recognised however long it is', () => {
  assert.equal(isPreamble(PREAMBLE), true);
  assert.equal(isPreamble(['/bin/bash', '-c', 'npm test']), false);
});

test('bareCommand strips the shell wrapper Codex puts on every tool call', () => {
  assert.equal(bareCommand(['/bin/bash', '-c', 'cd /workspace/demo && npm test']), 'cd /workspace/demo && npm test');
  assert.equal(bareCommand(['/bin/bash', '-lc', 'ls -la']), 'ls -la');
  assert.equal(bareCommand(['sh', '-c', 'echo hi']), 'echo hi');
  assert.equal(bareCommand(['node', '-e', 'x']), 'node -e x');
});

test('one npm test folds from four exec events to one command', () => {
  // Exactly the sequence observed in the sandbox for pid 265.
  const { commands, folded } = fold([
    exec(1, 265, 156, PREAMBLE),
    exec(2, 265, 156, ['/bin/bash', '-c', 'cd /workspace/demo && npm test']),
    exec(3, 265, 156, ['/usr/local/bin/npm', 'test']),
    exec(4, 265, 156, ['node', '/usr/local/bin/npm', 'test']),
    exec(5, 294, 265, ['getconf', 'LONG_BIT']),
    exit(6, 265, 0),
  ]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, 'cd /workspace/demo && npm test', 'keeps the command as the agent wrote it');
  assert.equal(commands[0].exit_code, 0);
  assert.equal(folded.preamble, 1);
  assert.equal(folded.reexec, 2);
  assert.equal(folded.machinery, 1);
  assert.ok(folded.preambleChars > 50, 'reports how much preamble it folded');
});

test('a shell that execs exactly what it was handed is one action, not two', () => {
  // The real npm-test tree: `sh -c "node -e X"` forks `node -e X`. Two
  // processes doing one thing -- listing both reads as the agent having
  // deleted the same file twice.
  const { commands } = fold([
    exec(1, 265, 156, ['/bin/bash', '-c', 'npm test']),
    exec(2, 277, 265, ['sh', '-c', "node -e \"require('fs').unlinkSync('keep.txt')\""]),
    exec(3, 278, 277, ['node', '-e', "require('fs').unlinkSync('keep.txt')"]),
    exit(4, 278, 3), exit(5, 277, 0), exit(6, 265, 0),
  ]);
  assert.deepEqual(commands.map((c) => c.pid), [265, 277]);
  assert.equal(commands[0].parent_event_id, null, 'the top-level command owns itself');
  assert.equal(commands[1].parent_event_id, 1, 'the surviving line still hangs off npm test');
  assert.equal(commands[1].exit_code, 3, 'keeps the outcome of the process that did the work');
});

test('a child doing different work stays its own step', () => {
  const { commands } = fold([
    exec(1, 265, 156, ['/bin/bash', '-c', 'npm test']),
    exec(2, 277, 265, ['sh', '-c', 'rm -rf dist']),
    exec(3, 278, 277, ['rm', '-rf', 'dist']),
    exec(4, 279, 265, ['node', '-e', "console.log('1 passing')"]),
  ]);
  // 277/278 collapse (same work); 279 is genuinely separate.
  assert.deepEqual(commands.map((c) => c.pid), [265, 277, 279]);
  assert.deepEqual(commands.map((c) => c.parent_event_id), [null, 1, 1]);
});

test('exits attach to the command that owns the pid', () => {
  const { commands, folded } = fold([exec(1, 10, 1, ['ls', '-la']), exit(2, 10, 3)]);
  assert.equal(commands[0].exit_code, 3);
  assert.equal(commands[0].ended_ns, NS(1_700_000_000_002));
  assert.equal(folded.exits, 1);
});

test('rules describe common commands from what the text already proves', () => {
  const cases = [
    ['mkdir -p /workspace/demo3', 'created folder /workspace/demo3'],
    ['ls -la /workspace/demo', 'listed files in /workspace/demo'],
    ['rm -rf /workspace/tmp', 'deleted /workspace/tmp'],
    ['cat > /workspace/demo/package.json', 'wrote …/demo/package.json'],
    ['echo "important work" > /workspace/demo3/keep.txt', 'wrote …/demo3/keep.txt'],
    ['npm test', 'ran the test script'],
    ['npm install', 'installed dependencies'],
    ['npm run build', 'ran the build script'],
    ['git status', 'ran git status'],
    ["node -e \"require('fs').unlinkSync('keep.txt')\"", 'deleted keep.txt'],
    ["node -e \"console.log('1 passing')\"", 'printed "1 passing"'],
    ["sh -c \"node -e \\\"require('fs').unlinkSync('keep.txt')\\\"\"", 'deleted keep.txt'],
  ];
  for (const [command, expected] of cases) {
    assert.equal(describeCommand(command), expected, command);
  }
});

test('a compound command is described by the step that does the work, not the cd', () => {
  assert.equal(describeCommand('cd /workspace/demo && npm test'), 'ran the test script');
  assert.equal(describeCommand('cd /workspace/demo3 && ls -la'), 'listed files in .');
});

test('an unknown command returns null rather than a guess', () => {
  // The whole point: a wrong sentence in an evidence tool is worse than no
  // sentence, so anything the rules cannot prove falls through.
  assert.equal(describeCommand('some-vendor-tool --frobnicate /tmp/x'), null);
  assert.equal(describeCommand("node -e \"doSomethingUnusual()\""), null);
  assert.equal(describeCommand(''), null);
  assert.equal(describeCommand(null), null);
});

test('undescribed() returns the deduplicated batch to send to a model, once', () => {
  const { commands } = fold([
    exec(1, 10, 1, ['mkdir', '-p', '/tmp/a']),              // rule covers it
    exec(2, 11, 1, ['vendor-tool', '--run']),               // unknown
    exec(3, 12, 1, ['vendor-tool', '--run']),               // same unknown again
    exec(4, 13, 1, ['other-tool']),                         // different unknown
  ]);
  assert.deepEqual(undescribed(commands).sort((a, b) => a.localeCompare(b)), ['other-tool', 'vendor-tool --run']);
});

test('describeAll marks where each sentence came from', () => {
  const { commands } = fold([
    exec(1, 10, 1, ['npm', 'test']),
    exec(2, 11, 1, ['vendor-tool', '--run']),
    exec(3, 12, 1, ['mystery-binary']),
  ]);
  describeAll(commands, (command) => (command === 'vendor-tool --run' ? 'compiled the native addon' : null));

  assert.deepEqual(commands.map((c) => [c.description, c.description_source]), [
    ['ran the test script', 'rule'],
    ['compiled the native addon', 'model'],   // rendered as a model's reading, not observation
    [null, 'raw'],                            // no description available: show the command
  ]);
});

test('malformed events never throw', () => {
  assert.deepEqual(fold(undefined).commands, []);
  assert.deepEqual(fold([null, {}, { kind: 'exec_succeeded' }, { event_id: 'x' }]).commands, []);
});

test('describeRequest batches, deduplicates and caps the commands it sends', () => {
  const many = Array.from({ length: 40 }, (_, i) => `tool-${i} --run`);
  const { commands, payload } = describeRequest([...many, 'tool-0 --run'], 'test-model');
  assert.equal(commands.length, 25, 'capped');
  assert.equal(new Set(commands).size, 25, 'deduplicated');
  assert.equal(payload.model, 'test-model');
  assert.match(payload.input, /^1\. tool-0 --run\n2\. tool-1 --run/);
  assert.equal(payload.stream, false);
  assert.equal(payload.store, false);
});

test('parseDescriptions maps numbered replies back, and drops anything unclear', () => {
  const commands = ['vendor-tool --run', 'mystery-binary', 'third-thing'];
  const parsed = parseDescriptions([
    '1. compiled the native addon.',
    '2. unclear',
    'noise that is not a numbered line',
  ].join('\n'), commands);

  assert.equal(parsed.get('vendor-tool --run'), 'compiled the native addon', 'trailing period trimmed');
  assert.equal(parsed.has('mystery-binary'), false, 'the model said it could not tell');
  assert.equal(parsed.has('third-thing'), false, 'no answer means no description, not a guess');
});

test('parseDescriptions survives a garbled reply', () => {
  assert.equal(parseDescriptions('', ['a']).size, 0);
  assert.equal(parseDescriptions(null, ['a']).size, 0);
  assert.equal(parseDescriptions('99. out of range', ['a']).size, 0);
});

test('a folded parent hands its children to the nearest surviving ancestor', () => {
  // getconf is folded as machinery, but it is also the shell that ran the
  // pipeline. Before the lineage walk, 300/301 looked parentless and rendered
  // alongside `npm test` as though nothing had started them.
  const { commands } = fold([
    exec(1, 265, 156, ['/bin/bash', '-c', 'npm test']),
    exec(2, 294, 265, ['getconf', 'LONG_BIT']),
    exec(3, 300, 294, ['wc', '-l']),
    exec(4, 301, 300, ['tr', '-d', ' ']),
  ]);
  assert.deepEqual(commands.map((c) => c.pid), [265, 300, 301]);
  assert.equal(commands[1].parent_event_id, 1, 'skips the folded getconf up to npm test');
  assert.equal(commands[2].parent_event_id, 3, 'a surviving parent is still used directly');
});

test('a process whose parent ran outside the window stays at the top level', () => {
  // Nothing in this page started pid 400, so claiming a parent would be a
  // guess. Unattributed is the honest answer.
  const { commands } = fold([exec(1, 400, 399, ['ls', '-la'])]);
  assert.equal(commands[0].parent_event_id, null);
});

test('a lineage cycle cannot hang the parent walk', () => {
  const { commands } = fold([
    exec(1, 10, 11, ['ls']),
    exec(2, 11, 10, ['pwd']),
  ]);
  assert.equal(commands.length, 2);
});

test('pipeline stages nest under the shell that forked them, exec or no exec', () => {
  // `sed | wc | tr` forks a subshell per stage. A subshell inherits its
  // parent's image, so gVisor reports no exec for pid 97 -- only its exit,
  // which is where its ppid comes from.
  const { commands } = fold([
    exec(1, 68, 26, ['/bin/bash', '-c', 'source ~/.bashrc']),
    exec(2, 99, 97, ['sed', '/^$/d']),
    exec(3, 100, 97, ['wc', '-l']),
    exit(4, 99, 0), exit(5, 100, 0),
    { event_id: 6, kind: 'process_exit', pid: 97, ppid: 68, exit_code: 0, signal: null, timestamp_ns: NS(1_700_000_000_006) },
  ]);
  assert.deepEqual(commands.map((c) => c.pid), [68, 99, 100]);
  assert.deepEqual(commands.map((c) => c.parent_event_id), [null, 1, 1],
    'both stages hang off the shell, not off the top level');
});

test('a folded command keeps its process start time, so it can be matched to a call by pid + start', () => {
  const { commands } = fold([
    { ...exec(1, 265, 156, PREAMBLE), process_start_ns: '9000' },
    { ...exec(2, 265, 156, ['/bin/bash', '-c', 'npm test']), process_start_ns: '9000' },
  ]);
  assert.equal(commands[0].event_id, 2, 'the tree keeps a different exec event than the first one...');
  assert.equal(commands[0].process_start_ns, '9000', '...but the same process identity');
});
