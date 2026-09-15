import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, appendFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLatestSessionFile, readNewLines } from './execution-tailer.mjs';

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'raytace-tailer-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('findLatestSessionFile finds a session file created after the given time', () => withTempDir(async (codexHome) => {
  const now = Date.UTC(2026, 8, 11, 12, 0, 0); // 2026-09-11 (month is 0-indexed)
  const dayDir = join(codexHome, 'sessions', '2026', '09', '11');
  await mkdir(dayDir, { recursive: true });

  const oldFile = join(dayDir, 'rollout-old.jsonl');
  await writeFile(oldFile, '{}\n');
  await utimes(oldFile, new Date(now - 3600_000), new Date(now - 3600_000)); // an hour old — not ours

  const found = await findLatestSessionFile(codexHome, now, { now });
  assert.equal(found, null); // nothing new enough yet — the session hasn't written its file

  const newFile = join(dayDir, 'rollout-new.jsonl');
  await writeFile(newFile, '{}\n'); // mtime is "now" by virtue of just being written
  const foundAfter = await findLatestSessionFile(codexHome, now, { now });
  assert.equal(foundAfter, newFile);
}));

test('findLatestSessionFile checks yesterday too, for sessions spanning midnight', () => withTempDir(async (codexHome) => {
  const now = Date.UTC(2026, 8, 11, 0, 5, 0); // just after midnight
  const spawnedAt = Date.UTC(2026, 8, 10, 23, 58, 0); // spawned just before midnight
  const yesterdayDir = join(codexHome, 'sessions', '2026', '09', '10');
  await mkdir(yesterdayDir, { recursive: true });
  const file = join(yesterdayDir, 'rollout-cross-midnight.jsonl');
  await writeFile(file, '{}\n');
  await utimes(file, new Date(spawnedAt + 1000), new Date(spawnedAt + 1000));

  const found = await findLatestSessionFile(codexHome, spawnedAt, { now });
  assert.equal(found, file);
}));

test('findLatestSessionFile returns null when nothing exists yet', () => withTempDir(async (codexHome) => {
  const found = await findLatestSessionFile(codexHome, Date.now());
  assert.equal(found, null);
}));

test('readNewLines returns only complete lines and remembers the offset', () => withTempDir(async (dir) => {
  const file = join(dir, 'rollout.jsonl');
  await writeFile(file, '{"a":1}\n{"a":2}\n');

  const first = await readNewLines(file, 0);
  assert.deepEqual(first.lines, ['{"a":1}', '{"a":2}']);
  assert.equal(first.offset, 16); // exact byte length consumed

  // Nothing new yet — same offset in, empty lines out.
  const second = await readNewLines(file, first.offset);
  assert.deepEqual(second.lines, []);
  assert.equal(second.offset, first.offset);

  // A partial line (file being written concurrently) is held back.
  await appendFile(file, '{"a":3}\n{"a":4} <- incompl');
  const third = await readNewLines(file, second.offset);
  assert.deepEqual(third.lines, ['{"a":3}']);
  assert.ok(third.offset > second.offset && third.offset < second.offset + Buffer.byteLength('{"a":3}\n{"a":4} <- incompl'));

  // Finishing that line surfaces it on the next read.
  await appendFile(file, 'ete}\n');
  const fourth = await readNewLines(file, third.offset);
  assert.deepEqual(fourth.lines, ['{"a":4} <- incomplete}']);
}));

test('readNewLines tolerates a file that does not exist yet', async () => {
  const result = await readNewLines('/nonexistent/path/rollout.jsonl', 0);
  assert.deepEqual(result, { lines: [], offset: 0 });
});
