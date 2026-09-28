import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const schema = readFileSync(new URL('./schema/agent_intent.sql', import.meta.url), 'utf8');

function withDatabase(run) {
  const directory = mkdtempSync(join(tmpdir(), 'raytace-agent-schema-'));
  let db;
  try {
    db = new DatabaseSync(join(directory, 'test.db'));
    db.exec(schema);
    return run(db);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seed(db) {
  db.exec(`
    INSERT INTO agent_sessions(id, external_session_id, started_at_ms)
      VALUES ('s1', 'external-session', 100), ('s2', 'external-session', 100);
    INSERT INTO agent_turns(id, session_id, sequence_number, started_at_ms)
      VALUES ('t1', 's1', 0, 110), ('t2', 's2', 0, 110);
    INSERT INTO agent_exchanges(id, turn_id, session_id, provider, started_at_ms)
      VALUES ('e1', 't1', 's1', 'example', 120), ('e2', 't1', 's1', 'example', 130);
    INSERT INTO agent_tool_calls(id, exchange_id, external_call_id, output_index, tool_name)
      VALUES ('c1', 'e1', 'external-call', 0, 'exec_command'),
             ('c2', 'e1', 'another-call', 1, 'read_file'),
             ('c3', 'e2', 'external-call', 0, 'exec_command');
  `);
}

test('schema defines only the five intent tables and preserves rows on re-import', () => withDatabase(db => {
  seed(db);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(tables, ['agent_exchanges', 'agent_payloads', 'agent_sessions', 'agent_tool_calls', 'agent_turns']);
  const snapshot = () => tables.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
  const before = snapshot();
  db.exec(schema);
  assert.deepEqual(snapshot(), before);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}));

test('session-to-call join handles multiple exchanges and calls with reused external IDs', () => withDatabase(db => {
  seed(db);
  const rows = db.prepare(`SELECT s.id AS session, t.id AS turn, e.id AS exchange, c.id AS call
    FROM agent_sessions s JOIN agent_turns t ON t.session_id=s.id
    JOIN agent_exchanges e ON e.turn_id=t.id AND e.session_id=s.id
    JOIN agent_tool_calls c ON c.exchange_id=e.id WHERE s.id='s1'
    ORDER BY e.started_at_ms, c.output_index`).all();
  assert.deepEqual(rows.map(r => [r.session, r.turn, r.exchange, r.call]), [
    ['s1', 't1', 'e1', 'c1'], ['s1', 't1', 'e1', 'c2'], ['s1', 't1', 'e2', 'c3'],
  ]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM agent_tool_calls WHERE external_call_id='external-call'").get().n, 2);
}));

test('unresolved turn is valid but cross-session assignment fails on insert and update', () => withDatabase(db => {
  seed(db);
  db.exec("INSERT INTO agent_exchanges(id, session_id, provider, started_at_ms) VALUES ('unresolved', 's1', 'example', 140)");
  assert.equal(db.prepare("SELECT turn_id FROM agent_exchanges WHERE id='unresolved'").get().turn_id, null);
  assert.throws(() => db.exec("UPDATE agent_exchanges SET turn_id='t2' WHERE id='unresolved'"), /FOREIGN KEY/);
  assert.throws(() => db.exec("INSERT INTO agent_exchanges(id, turn_id, session_id, provider, started_at_ms) VALUES ('wrong', 't2', 's1', 'example', 140)"), /FOREIGN KEY/);
  db.exec("UPDATE agent_exchanges SET turn_id='t1' WHERE id='unresolved'");
}));

test('rejects duplicate positions and invalid ordinal types', () => withDatabase(db => {
  seed(db);
  for (const sql of [
    "INSERT INTO agent_turns(id, session_id, sequence_number, started_at_ms) VALUES ('duplicate', 's1', 0, 140)",
    "INSERT INTO agent_tool_calls(id, exchange_id, output_index, tool_name) VALUES ('duplicate', 'e1', 0, 'exec_command')",
    "UPDATE agent_turns SET sequence_number=-1 WHERE id='t1'",
    "UPDATE agent_turns SET sequence_number=0.5 WHERE id='t1'",
    "UPDATE agent_tool_calls SET output_index=-1 WHERE id='c1'",
    "UPDATE agent_tool_calls SET output_index='invalid' WHERE id='c1'",
  ]) assert.throws(() => db.exec(sql), /constraint failed/i, sql);
}));

test('validates payload JSON and references without requiring a reported result', () => withDatabase(db => {
  seed(db);
  for (const content of [JSON.stringify('Run the tests'), JSON.stringify({ command: 'npm test' })]) {
    const sha = createHash('sha256').update(content).digest('hex');
    db.prepare('INSERT INTO agent_payloads(sha, content) VALUES (?, ?)').run(sha, content);
    db.prepare("UPDATE agent_tool_calls SET arguments_sha=? WHERE id='c1'").run(sha);
  }
  const call = db.prepare("SELECT reported_result_sha, proposed_at_ms FROM agent_tool_calls WHERE id='c1'").get();
  assert.equal(call.reported_result_sha, null);
  assert.equal(call.proposed_at_ms, null);
  for (const sql of [
    "INSERT INTO agent_payloads VALUES ('bad', 'not json')",
    "UPDATE agent_sessions SET metadata_json='bad' WHERE id='s1'",
    "UPDATE agent_exchanges SET metrics_json='bad' WHERE id='e1'",
    "UPDATE agent_turns SET user_prompt_sha='missing' WHERE id='t1'",
    "UPDATE agent_tool_calls SET arguments_sha='missing' WHERE id='c1'",
    "UPDATE agent_tool_calls SET reported_result_sha='missing' WHERE id='c1'",
    "UPDATE agent_exchanges SET response_sha='missing' WHERE id='e1'",
    "UPDATE agent_tool_calls SET exchange_id='missing' WHERE id='c1'",
    "UPDATE agent_turns SET session_id='missing' WHERE id='t2'",
  ]) assert.throws(() => db.exec(sql), /constraint failed/i, sql);
}));

test('validates status, timestamps and explicitly non-null text keys', () => withDatabase(db => {
  seed(db);
  assert.equal(db.prepare("SELECT status FROM agent_turns WHERE id='t1'").get().status, 'unknown');
  for (const status of ['unknown', 'active', 'completed', 'failed', 'cancelled']) {
    db.prepare("UPDATE agent_turns SET status=? WHERE id='t1'").run(status);
  }
  for (const sql of [
    "UPDATE agent_turns SET status='executed' WHERE id='t1'",
    "UPDATE agent_sessions SET ended_at_ms=99 WHERE id='s1'",
    "UPDATE agent_turns SET ended_at_ms=109 WHERE id='t1'",
    "UPDATE agent_exchanges SET completed_at_ms=119 WHERE id='e1'",
    "UPDATE agent_sessions SET started_at_ms='invalid' WHERE id='s1'",
    "UPDATE agent_turns SET started_at_ms=1.5 WHERE id='t1'",
    "UPDATE agent_exchanges SET completed_at_ms='invalid' WHERE id='e1'",
    "UPDATE agent_tool_calls SET proposed_at_ms=1.5 WHERE id='c1'",
    "INSERT INTO agent_payloads VALUES (NULL, '{}')",
  ]) assert.throws(() => db.exec(sql), /constraint failed/i, sql);
  for (const table of ['agent_sessions', 'agent_turns', 'agent_exchanges', 'agent_tool_calls']) {
    assert.throws(() => db.exec(`UPDATE ${table} SET id=NULL`), /NOT NULL/, table);
  }
  db.exec("UPDATE agent_sessions SET ended_at_ms=100 WHERE id='s1'");
}));

test('referenced evidence cannot be cascade-deleted', () => withDatabase(db => {
  seed(db);
  db.exec("INSERT INTO agent_payloads VALUES ('payload', '{}'); UPDATE agent_tool_calls SET arguments_sha='payload' WHERE id='c1'");
  for (const sql of [
    "DELETE FROM agent_sessions WHERE id='s1'",
    "DELETE FROM agent_turns WHERE id='t1'",
    "DELETE FROM agent_exchanges WHERE id='e1'",
    "DELETE FROM agent_payloads WHERE sha='payload'",
  ]) assert.throws(() => db.exec(sql), /FOREIGN KEY/, sql);
  assert.equal(db.prepare('SELECT count(*) AS n FROM agent_tool_calls').get().n, 3);
}));
