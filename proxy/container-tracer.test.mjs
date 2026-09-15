import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTracerLine } from './container-tracer.mjs';

// These tests pin down parseTracerLine's defensive behavior against the
// sidecar's own output format (docker/tracer/entrypoint.sh). The format is
// a plain contract we control on both ends (unlike eslogger's JSON, which
// had to be verified against real captured output) -- still tested
// defensively because the sidecar's stdout and stderr are not guaranteed
// to only ever contain well-formed lines (a partial write, a bpftrace
// warning line, etc. should never throw here).

test('parses a well-formed EXEC line with a fixed clock', () => {
  const now = () => 123456;
  assert.deepEqual(
    parseTracerLine('EXEC\t4213\tgit status --porcelain', now),
    { kind: 'exec', pid: 4213, command: 'git status --porcelain', timestamp: 123456 },
  );
});

test('EXEC command can itself contain tabs (rejoined, not truncated)', () => {
  const now = () => 1;
  assert.deepEqual(
    parseTracerLine('EXEC\t10\tprintf\ta\tb', now),
    { kind: 'exec', pid: 10, command: 'printf\ta\tb', timestamp: 1 },
  );
});

test('parses a well-formed EXIT line', () => {
  assert.deepEqual(parseTracerLine('EXIT\t4213'), { kind: 'exit', pid: 4213 });
});

test('rejects a non-numeric pid', () => {
  assert.equal(parseTracerLine('EXEC\tnotapid\tls'), null);
  assert.equal(parseTracerLine('EXIT\tnotapid'), null);
});

test('rejects an EXEC line with an empty command', () => {
  assert.equal(parseTracerLine('EXEC\t10\t'), null);
  assert.equal(parseTracerLine('EXEC\t10\t   '), null);
});

test('rejects an unknown event kind', () => {
  assert.equal(parseTracerLine('FORK\t1\t2'), null);
});

test('rejects blank lines and the sidecar\'s own diagnostic stderr lines', () => {
  assert.equal(parseTracerLine(''), null);
  assert.equal(parseTracerLine('[tracer] scoping to cgroup: /sys/fs/cgroup/docker/abc123'), null);
});

test('rejects non-string input rather than throwing', () => {
  assert.equal(parseTracerLine(null), null);
  assert.equal(parseTracerLine(undefined), null);
});
