import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeEvidenceDatabase, CATALOG_VERSION_ID, SCHEMA_VERSION } from './init-evidence-db.mjs';

function isolated(run) {
  const dir = mkdtempSync(join(tmpdir(), 'raytace-evidence-test-'));
  const path = join(dir, 'evidence.db');
  let db;
  try {
    initializeEvidenceDatabase(path);
    db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys=ON');
    return run(db, path, dir);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
}

function insert(db, table, values, prefix = 'INSERT') {
  db.prepare(`${prefix} INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values));
}

function fixtures(db) {
  for (const id of ['a', 'b']) {
    insert(db, 'runtime_sandboxes', { id, external_container_id: id, runtime_name: 'gvisor', runtime_version: 'test', architecture: 'aarch64', capture_config_json: '{}' });
    insert(db, 'runtime_processes', { id: `p-${id}`, sandbox_id: id, pid: 101, first_seen_ns: '9007199254740993000', identity_basis: 'test' });
  }
  insert(db, 'agent_sessions', { id: 's', started_at_ms: 100 });
  insert(db, 'agent_turns', { id: 't', session_id: 's', sequence_number: 0, started_at_ms: 100 });
  insert(db, 'agent_exchanges', { id: 'x', turn_id: 't', session_id: 's', provider: 'test', started_at_ms: 100 });
  insert(db, 'agent_tool_calls', { id: 'tool', exchange_id: 'x', output_index: 0, tool_name: 'exec_command' });
}

let sequence = 0;
function event(db, id, overrides = {}) {
  insert(db, 'runtime_events', { id, sandbox_id: 'a', process_id: 'p-a', stream_id: 'stream', stream_sequence: sequence++,
    event_kind: 'syscall_enter', observed_at_ns: '9007199254740993001', received_at_ms: 100,
    tid: 101, payload_json: '{"syscall_name":"unlinkat","syscall_number":35}', decoder_version: 'test', ...overrides });
}

function call(db, id, options = {}) {
  const { outcome = 'succeeded', ...overrides } = options;
  event(db, `${id}-entry`);
  event(db, `${id}-exit`, { event_kind: 'syscall_exit', payload_json: JSON.stringify({ syscall_name: 'unlinkat', syscall_number: 35,
    return_value: outcome === 'failed' ? '-1' : '0', errno: outcome === 'failed' ? 13 : 0 }) });
  const row = { id, sandbox_id: 'a', process_id: 'p-a', tid: 101, syscall_name: 'unlinkat', syscall_number: 35,
    entry_event_id: `${id}-entry`, exit_event_id: `${id}-exit`, arguments_json: '{"pathname":"notes.md"}',
    return_value: outcome === 'failed' ? '-1' : '0', errno: outcome === 'failed' ? 13 : 0,
    outcome, correlation_status: 'paired', normalizer_version: 'test', ...overrides };
  insert(db, 'runtime_syscall_calls', row);
  return row;
}

function result(db, id, callId, extra = {}) {
  insert(db, 'classification_results', { id, syscall_call_id: callId, version_id: CATALOG_VERSION_ID,
    input_sha256: 'a'.repeat(64), category_id: 'delete', operation_level: 3, confirmed_effect_level: 3,
    effect_status: 'confirmed', reason: 'Test fixture, not automatic classification', classified_at_ms: 101, ...extra });
}

test('26 tables, catalog seeds and repeat initialization preserve evidence', () => isolated((db, path) => {
  fixtures(db); call(db, 'delete');
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n, 26); // 20 evidence tables + 6 auxiliary
  for (const [table, count] of [['classification_impact_levels', 4], ['classification_categories', 13], ['classification_syscall_rules', 84], ['file_labels', 6], ['classification_results', 0]]) {
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, count);
  }
  const before = db.prepare('SELECT * FROM runtime_syscall_calls').all();
  assert.equal(initializeEvidenceDatabase(path).created, false);
  assert.deepEqual(db.prepare('SELECT * FROM runtime_syscall_calls').all(), before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('SELECT classifier_version FROM classification_versions').get().classifier_version, 'not-implemented');
}));

test('cross-sandbox references are rejected, including nullable process context', () => isolated(db => {
  fixtures(db);
  assert.throws(() => db.exec("UPDATE runtime_processes SET parent_process_id='p-b' WHERE id='p-a'"), /FOREIGN KEY/);
  assert.throws(() => event(db, 'wrong', { process_id: 'p-b' }), /FOREIGN KEY/);
  assert.throws(() => event(db, 'no-sandbox', { sandbox_id: null }), /CHECK/);
  event(db, 'other', { sandbox_id: 'b', process_id: 'p-b' });
  assert.throws(() => insert(db, 'runtime_syscall_calls', { id: 'wrong', sandbox_id: 'a', syscall_number: 35,
    entry_event_id: 'other', arguments_json: '{}', outcome: 'unknown', correlation_status: 'entry_only', normalizer_version: 'test' }), /FOREIGN KEY/);
  call(db, 'ok');
  insert(db, 'file_objects', { id: 'object-b', sandbox_id: 'b', object_type: 'regular', identity_basis: 'test', first_seen_ns: '1', last_seen_ns: '1' });
  for (const values of [{ sandbox_id: 'b' }, { sandbox_id: 'a', file_object_id: 'object-b' }]) {
    assert.throws(() => insert(db, 'file_operation_targets', { id: 'wrong-target', syscall_call_id: 'ok', target_role: 'target', resolution_status: 'unresolved', ...values }), /FOREIGN KEY/);
  }
}));

test('PID reuse, repeated exec and collector-wide events are representable', () => isolated(db => {
  fixtures(db);
  insert(db, 'runtime_processes', { id: 'p-reused', sandbox_id: 'a', pid: 101, start_time_ns: '9007199254740994000', first_seen_ns: '9007199254740994001', identity_basis: 'start_time' });
  event(db, 'exec1', { event_kind: 'exec_succeeded', payload_json: '{"executable":"sh"}' });
  event(db, 'exec2', { event_kind: 'exec_succeeded', payload_json: '{"executable":"node"}' });
  event(db, 'gap', { sandbox_id: null, process_id: null, tid: null, observed_at_ns: null, event_kind: 'collection_gap', payload_json: '{"dropped_delta":3}' });
  assert.equal(db.prepare('SELECT started_at_ms FROM runtime_sandboxes LIMIT 1').get().started_at_ms, null);
  const original = db.prepare("SELECT * FROM runtime_events WHERE id='exec1'").get();
  assert.throws(() => insert(db, 'runtime_events', { ...original, id: 'duplicate' }), /cannot be replaced/);
  assert.throws(() => insert(db, 'runtime_events', { ...original, id: 'replacement' }, 'INSERT OR REPLACE'), /cannot be replaced/);
  assert.equal(db.prepare('SELECT count(*) n FROM runtime_attributions').get().n, 0);
}));

test('known outcomes require reliable phases, matching identities and decoded results', () => isolated(db => {
  fixtures(db);
  const success = call(db, 'success');
  call(db, 'failure', { outcome: 'failed' });
  insert(db, 'runtime_syscall_calls', { ...success, id: 'entry', exit_event_id: null, outcome: 'unknown', return_value: null, errno: null, correlation_status: 'entry_only' });
  insert(db, 'runtime_syscall_calls', { ...success, id: 'exit', entry_event_id: null, correlation_status: 'exit_only' });
  insert(db, 'runtime_syscall_calls', { ...success, id: 'uncertain', correlation_status: 'uncertain', outcome: 'unknown' });
  for (const override of [
    { outcome: 'failed' }, { outcome: 'unknown', errno: 13 }, { return_value: '1' }, { correlation_status: 'uncertain' },
    { exit_event_id: null }, { syscall_number: 99 }, { syscall_name: 'write' }, { tid: 102 },
    { entry_event_id: success.exit_event_id, exit_event_id: success.entry_event_id },
    { return_value: '-0' }, { return_value: '00' }, { return_value: '1.5' },
  ]) assert.throws(() => insert(db, 'runtime_syscall_calls', { ...success, id: 'bad', ...override }));
  event(db, 'mismatched-thread', { tid: 102 });
  assert.throws(() => insert(db, 'runtime_syscall_calls', { ...success, id: 'hidden-tid', tid: null, entry_event_id: 'mismatched-thread' }), /disagree/);
  event(db, 'earlier-exit', { event_kind: 'syscall_exit', observed_at_ns: '9007199254740993000', payload_json: '{"return_value":"0","errno":0}' });
  assert.throws(() => insert(db, 'runtime_syscall_calls', { ...success, id: 'backwards', exit_event_id: 'earlier-exit' }), /disagree/);
}));

test('classification preserves impact versus effect and is append-only even through REPLACE', () => isolated(db => {
  fixtures(db);
  call(db, 'success'); call(db, 'failure', { outcome: 'failed' });
  call(db, 'unknown', { outcome: 'unknown', correlation_status: 'uncertain' });
  result(db, 'r', 'success');
  assert.throws(() => result(db, 'bad-fail', 'failure'), /successful syscall/);
  assert.throws(() => result(db, 'bad-unknown', 'unknown'), /successful syscall/);
  result(db, 'failed-class', 'failure', { confirmed_effect_level: null, effect_status: 'no_effect' });
  assert.throws(() => result(db, 'bad-level', 'success', { input_sha256: 'b'.repeat(64), effect_status: 'unknown' }), /CHECK/);
  for (const table of ['classification_versions', 'classification_syscall_rules', 'classification_results', 'classification_categories', 'classification_impact_levels']) {
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /append-only/);
    const row = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
    const key = Object.keys(row)[0];
    assert.throws(() => db.exec(`UPDATE ${table} SET ${key}=${key}`), /append-only/);
    assert.throws(() => insert(db, table, row, 'INSERT OR REPLACE'), /cannot be replaced/);
  }
  const saved = db.prepare("SELECT * FROM classification_results WHERE id='r'").get();
  assert.throws(() => insert(db, 'classification_results', { ...saved, id: 'replacement' }, 'INSERT OR REPLACE'), /cannot be replaced/);
}));

test('deletion joins to accepted tool attribution, classification and multiple file labels', () => isolated(db => {
  fixtures(db); call(db, 'delete'); result(db, 'r', 'delete');
  insert(db, 'runtime_attributions', { id: 'link', tool_call_id: 'tool', event_id: 'delete-exit', method: 'marker', confidence: 'exact', status: 'accepted', basis_json: '{}', attributor_version: 'test', created_at_ms: 100 });
  for (const id of ['old-file', 'new-file']) insert(db, 'file_objects', { id, sandbox_id: 'a', object_type: 'regular', identity_basis: 'fixture', first_seen_ns: '1', last_seen_ns: '2' });
  for (const [id, object] of [['target', 'old-file'], ['reused-path', 'new-file']]) {
    insert(db, 'file_operation_targets', { id, syscall_call_id: 'delete', sandbox_id: 'a', file_object_id: object, target_role: 'target', observed_path: '/workspace/notes.md', resolution_status: 'runtime_resolved' });
  }
  for (const label of ['documentation', 'potentially_sensitive']) insert(db, 'file_label_assignments', { id: label, target_id: 'target', label_id: label, basis: 'fixture', confidence: 'inferred', rule_version: 'test', reason: 'test only', assigned_at_ms: 100 });
  const rows = db.prepare(`SELECT tc.tool_name,c.label AS category,r.operation_level,r.effect_status,t.observed_path,l.label AS file_label
    FROM runtime_attributions a JOIN agent_tool_calls tc ON tc.id=a.tool_call_id
    JOIN runtime_syscall_calls s ON s.exit_event_id=a.event_id
    JOIN classification_results r ON r.syscall_call_id=s.id
    JOIN classification_categories c ON c.id=r.category_id
    JOIN file_operation_targets t ON t.syscall_call_id=s.id
    JOIN file_label_assignments fl ON fl.target_id=t.id JOIN file_labels l ON l.id=fl.label_id
    WHERE a.status='accepted'`).all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.tool_name === 'exec_command' && r.operation_level === 3 && r.effect_status === 'confirmed' && r.observed_path === '/workspace/notes.md'));
  assert.ok(rows.every(r => r.category === 'Delete'));
  event(db, 'rename-entry', { payload_json: '{"syscall_name":"renameat2","syscall_number":276}' });
  insert(db, 'runtime_syscall_calls', { id: 'rename', sandbox_id: 'a', syscall_name: 'renameat2', syscall_number: 276,
    entry_event_id: 'rename-entry', arguments_json: '{}', outcome: 'unknown', correlation_status: 'entry_only', normalizer_version: 'test' });
  for (const role of ['source', 'destination', 'replaced_destination']) insert(db, 'file_operation_targets', { id: role, syscall_call_id: 'rename', sandbox_id: 'a', target_role: role, resolution_status: 'unresolved' });
}));

test('JSON, enums, exact timestamps, context and foreign-key deletion constraints', () => isolated(db => {
  fixtures(db); call(db, 'delete');
  for (const sql of [
    "UPDATE runtime_sandboxes SET architecture='unknown' WHERE id='a'",
    "UPDATE runtime_sandboxes SET ended_at_ms='tomorrow' WHERE id='a'",
    "UPDATE runtime_sandboxes SET started_at_ms=10,ended_at_ms=9 WHERE id='a'",
    "UPDATE runtime_sandboxes SET capture_config_json='[]' WHERE id='a'",
    "UPDATE runtime_processes SET first_seen_ns='01' WHERE id='p-a'",
    "UPDATE runtime_processes SET exited_at_ns='9007199254740992999' WHERE id='p-a'",
    "DELETE FROM runtime_sandboxes WHERE id='a'",
    "DELETE FROM agent_exchanges WHERE id='x'",
  ]) assert.throws(() => db.exec(sql));
  assert.throws(() => event(db, 'invalid-json', { payload_json: 'invalid' }));
  assert.throws(() => event(db, 'invalid-seq', { stream_sequence: -1 }));
  insert(db, 'agent_payloads', { sha: 'fixture', content: '"prompt"' });
  insert(db, 'agent_context_items', { exchange_id: 'x', position: 0, payload_sha: 'fixture' });
  assert.throws(() => insert(db, 'agent_context_items', { exchange_id: 'x', position: -1, payload_sha: 'fixture' }));
  assert.throws(() => db.exec("DELETE FROM agent_payloads WHERE sha='fixture'"), /FOREIGN KEY/);
}));

test('initializer rejects unrelated/changed databases and rolls back on verification errors', () => isolated((db, path, dir) => {
  const unrelatedPath = join(dir, 'unrelated.db');
  const unrelated = new DatabaseSync(unrelatedPath);
  try {
    unrelated.exec('CREATE TABLE keep(value); INSERT INTO keep VALUES (42)');
    assert.throws(() => initializeEvidenceDatabase(unrelatedPath), /Incompatible/);
    assert.equal(unrelated.prepare('SELECT value FROM keep').get().value, 42);
    assert.equal(unrelated.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table'").get().n, 1);
  } finally { unrelated.close(); }
  db.exec('PRAGMA user_version=99');
  assert.throws(() => initializeEvidenceDatabase(path), /schema version/);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  db.exec("UPDATE file_labels SET description='tampered' WHERE id='temporary'");
  assert.throws(() => initializeEvidenceDatabase(path), /seed/);
  assert.equal(db.prepare("SELECT description FROM file_labels WHERE id='temporary'").get().description, 'tampered');
  db.exec('CREATE TABLE unrelated(value)');
  assert.throws(() => initializeEvidenceDatabase(path), /schema structure/);
  assert.throws(() => initializeEvidenceDatabase(), /explicit/);
}));

test('a version-2 database is upgraded in place to add call_assessments, keeping its data', () => isolated((db, path) => {
  // Recreate exactly what a v2 database looked like: no call_assessments.
  db.exec('DROP INDEX call_assessments_call; DROP TABLE call_assessments; PRAGMA user_version=2');
  insert(db, 'command_descriptions', { key: 'k', command: 'ls', description: 'listed files', created_at_ms: 1 });
  const result = initializeEvidenceDatabase(path);
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.created, false);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='call_assessments'").get().n, 1);
  assert.equal(db.prepare("SELECT description FROM command_descriptions WHERE key='k'").get().description, 'listed files');
}));

test('same catalog version with changed content is rejected without rewriting history', () => isolated((db, path) => {
  // Simulate out-of-band administrative corruption, then restore the schema
  // exactly so reinitialization must validate seed contents, not only DDL.
  const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name='classification_versions_no_update'").get().sql;
  db.exec('DROP TRIGGER classification_versions_no_update');
  db.prepare('UPDATE classification_versions SET content_sha256=? WHERE id=?').run('f'.repeat(64), CATALOG_VERSION_ID);
  db.exec(trigger);
  assert.throws(() => initializeEvidenceDatabase(path), /catalog version/);
  assert.equal(db.prepare('SELECT content_sha256 FROM classification_versions').get().content_sha256, 'f'.repeat(64));
  assert.equal(db.prepare('SELECT count(*) n FROM classification_syscall_rules').get().n, 84);
  // A rollback releases the write transaction even while this reader stays open.
  db.exec('BEGIN IMMEDIATE; ROLLBACK');
}));
