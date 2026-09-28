# Evidence database — version 3

This is RayTrace's database: **20 evidence tables plus 6 auxiliary tables** in
one SQLite file, `.raytace/evidence.db`, created on the proxy's first start.
It describes agent intent, observed runtime activity, interpretation rules and
results, file context, and shared payloads; `auxiliary.sql` holds the lab's
experiment jobs and cached summaries, explanations, command descriptions and
Jev command assessments (`call_assessments`).

`proxy/evidence-store.mjs` is the only module that reads or writes it. The
agent-intent tables are filled as model requests are captured; the runtime
tables (`runtime_sandboxes`, `runtime_processes`, `runtime_events`,
`runtime_attributions`) by the gVisor forwarder. Nothing yet captures file
syscalls, normalizes `runtime_syscall_calls`, classifies, or labels files, so
those tables stay empty.

Version 2 added the columns the proxy and dashboard need: turn detection
(`agent_turns.prompt_key`), request routing and the request split
(`agent_exchanges.route`, `method`, `tools_sha`, `input_key`, `transport_json`),
the sandbox-to-session join (`runtime_sandboxes.project_id`), proxy-clock times
and lost-evidence marking on processes, and match details on attributions
(`score`, the causal window, `reported_check`).

Version 3 added `call_assessments`, the cache of Jev (TypeSafe) severity and
step labels per tool call (`proxy/call-assessment.mjs`). It is the first
version with a migration: a version-2 database gains that one table in place,
inside the initializer's transaction, and is then checked against the schema
files exactly as before. A database at any other version is still refused
untouched; delete it to start fresh.

## Initialize and validate

From the repository root, with the project's Node version:

```sh
evidence_dir=$(mktemp -d)
node --disable-warning=ExperimentalWarning proxy/init-evidence-db.mjs "$evidence_dir/evidence.db"
node --disable-warning=ExperimentalWarning --test proxy/evidence-schema.test.mjs proxy/agent-intent-schema.test.mjs
```

An explicit file path is required; the parent directory must already exist.
There is no default pointing at a live database. The initializer rejects the
known live paths, unrelated schemas, and incompatible versions. It does not
delete existing files. A failed first import can leave an empty file; table
creation, seeding, and `user_version` are rolled back together.

The initializer owns one transaction for all modules. The existing agent-only
SQL retains its direct-import transaction; the loader removes that known wrapper
when composing it. Other modules are fragments loaded by the initializer in
agent → runtime → classification → file context → shared storage order.

`PRAGMA user_version=1` identifies the combined schema. Repeat initialization
compares schema objects (including triggers and indexes), verifies the seeded
catalog and file labels, and preserves all rows. It does not repair unexpected
changes. Even semantically equivalent manual DDL edits may fail this strict
comparison. Enable `PRAGMA foreign_keys=ON` on every writer connection.

The initializer imports the original `worker/gvisor/syscall_catalog.sql` into an
in-memory staging DB, then maps its 4 levels, 13 categories, and 84 rules. No
second manually maintained syscall list exists. Required-evidence prose becomes
a one-element JSON array. SHA-256 of the sorted canonical seed representation
identifies catalog contents. Version `filesystem-catalog-v1-only` has classifier
version `not-implemented`; initialization creates **zero classification results**.
A changed catalog needs a new version identifier and a deliberate initializer
update, never an overwrite under the old identifier.

## Field guide

`PK` = primary key, `FK` = foreign key, `?` = nullable. IDs are non-null text.
JSON is stored as validated text; packets are optional binary blobs. Timestamps
ending in `_ms` are integer epoch milliseconds. `_ns` values are canonical,
nonnegative decimal text; comparisons use digit length then binary lexical order
to avoid floating-point precision loss. Return values use canonical signed
decimal text. Unknown values stay null rather than becoming zero or success.

### Agent intent — 4 tables

| Table | Fields and meaning |
| --- | --- |
| `agent_sessions` | `id` PK; `external_session_id?` provider identifier; `agent_name?`; `started_at_ms`; `ended_at_ms?`; `metadata_json?` additional session metadata. |
| `agent_turns` | `id` PK; `session_id` FK to sessions; `sequence_number` position within session; `user_prompt_sha?` and `final_response_sha?` FKs to payloads; `started_at_ms`; `ended_at_ms?`; `status` agent lifecycle. |
| `agent_exchanges` | `id` PK; `session_id` FK; `turn_id?` with session-scoped FK to turns; `provider`; `model?`; `started_at_ms`; `completed_at_ms?`; `http_status?`; `request_sha?` and `response_sha?` FKs to payloads; `metrics_json?`. |
| `agent_tool_calls` | `id` PK; `exchange_id` FK; `external_call_id?`; `output_index` position within response; `tool_name`; `arguments_sha?` and `reported_result_sha?` FKs to payloads; `proposed_at_ms?`. |

Turn status is `unknown`, `active`, `completed`, `failed`, or `cancelled`.
External identifiers are not globally unique. Reported results are not
independent evidence of execution. See [agent schema guide](README.md) for details.

### Runtime evidence — 5 tables

| Table | Fields and meaning |
| --- | --- |
| `runtime_sandboxes` | `id` PK for one lifetime; `external_container_id` runtime container identifier; `runtime_name`; `runtime_version`; `runtime_build_digest?` custom build identity; `architecture` (`aarch64`/`x86_64`); `started_at_ms?`; `ended_at_ms?`; `capture_config_json` fixed monitoring configuration. |
| `runtime_processes` | `id` PK; `sandbox_id` FK; `pid`; `start_time_ns?`; `parent_process_id?` FK within the same sandbox; `observed_ppid?` unresolved numeric parent; `first_seen_ns`; `exited_at_ns?`; `exit_code?`; `exit_signal?`; `identity_basis` how the lifetime was distinguished. |
| `runtime_events` | `id` PK; `sandbox_id?` FK; `process_id?` sandbox-scoped FK; `stream_id` collector stream; `stream_sequence` collector-assigned position; `event_kind`; `observed_at_ns?` runtime time; `received_at_ms` collection time; `tid?` thread; `payload_json` decoded object; `retained_packet?` original bytes when permitted; `decoder_version`. |
| `runtime_syscall_calls` | `id` PK; `sandbox_id` FK; `process_id?` sandbox-scoped FK; `tid?`; `syscall_name?`; `syscall_number`; `entry_event_id?` and `exit_event_id?` sandbox-scoped FKs; `arguments_json` object; `return_value?`; `errno?`; `outcome`; `correlation_status`; `normalizer_version`. |
| `runtime_attributions` | `id` PK; `tool_call_id` FK to agent calls; `event_id` FK to observations; `method` matching technique; `confidence` strength; `status` candidate/accepted/rejected; `basis_json` supporting details; `attributor_version`; `created_at_ms`. |

Sandbox times describe the sandbox, not a prompt. An unknown end does not prove
it is running. A restarted lifetime gets a new internal ID. Configuration cannot
be updated in place; runtime version/build records what produced the evidence.

PID alone is not unique. Start identity is immutable, including an unknown start;
future reconciliation must be explicit rather than silently changing process
identity. Multiple exec events may describe executable changes in one process.
Normal exit code and terminating signal are mutually exclusive, and require an
exit time. A process reference always requires sandbox context.

Events are append-only, unique by `(stream_id, stream_sequence)`. Stream IDs must
be globally unique per collection connection/lifetime; their sequence is not a
kernel completeness guarantee. Collector-wide gaps may have neither sandbox nor
process. `event_kind` is extensible; normalized syscall phases are specifically
`syscall_enter` and `syscall_exit`. This differs from the old collector's return
label and will require an adapter in later integration.

For syscall evidence, decoded `payload_json` reserves these keys:

```json
{"syscall_number":35,"syscall_name":"unlinkat","return_value":"0","errno":0}
```

The number above is an ARM64 example. Entry events omit return information.
Number/name may be absent if undecoded; present known identities must match the
normalized call. Known outcomes require matching textual `return_value` and
integer `errno` in the exit payload. No pathname or contents are invented by SQL.

Syscall states:

| Correlation | Evidence | Allowed outcome |
| --- | --- | --- |
| `paired` | Entry and exit | `succeeded`, `failed`, `unknown` |
| `entry_only` | Entry only | `unknown` |
| `exit_only` | Exit only | `succeeded`, `failed`, `unknown` |
| `uncertain` | At least one observation | `unknown` |

Known process/thread identities and phases must agree even if the normalized
call omits those identities. Exit time cannot precede entry time. A known outcome
requires a decoded return; success requires errno 0, failure errno > 0. An
exit-only call can have a known outcome while its arguments/path remain unknown.

Normalized calls are append-only snapshots. If later evidence permits a better
reconstruction, insert a new row referencing the same observations; do not edit
evidence underlying existing classifications. This schema does not choose a
current reconstruction or deduplicate such snapshots automatically. A future
normalizer must define that selection before user-facing aggregation.

Attribution confidence is `exact`, `corroborated`, or `inferred`. Status is
`candidate`, `accepted`, or `rejected`; only accepted associations should be
presented as the chosen match. No match leaves the observation intact. This
schema does not assert that a shared process automatically belongs to one turn.

### Classification — 5 tables

| Table | Fields and meaning |
| --- | --- |
| `classification_versions` | `id` PK; `catalog_version`; `classifier_version`; `content_sha256` canonical rule content digest; `created_at_ms`; `description`. |
| `classification_impact_levels` | `level` PK, integer 0–3; `label`; `description`. |
| `classification_categories` | `id` PK, stable operation name; `label`; `description`. |
| `classification_syscall_rules` | composite PK `(version_id, syscall_name)`; `version_id` FK; `description`; `category_id` FK; `default_impact_level?` FK; `rule_identifier`; `required_evidence_json` array; `interpretation_notes`. |
| `classification_results` | `id` PK; `syscall_call_id` FK; `version_id` FK; `input_sha256` digest of classifier input; `category_id?` FK; `operation_level?` and `confirmed_effect_level?` FKs; `effect_status`; `reason`; `classified_at_ms`. |

Version, rule, result, category and impact rows reject updates, deletes, and key
replacement. New versions/results are new rows; additions within a version must
be completed by its publisher before use. SQL does not compute arbitrary new
version digests; publication tooling must verify them. Initializer-owned seeds
are verified on every repeat initialization.

Result uniqueness is `(syscall_call_id, version_id, input_sha256)`. The future
classifier computes the digest over its canonical input, including relevant
evidence/context; SQL validates digest shape, not the hash calculation. States:
`confirmed`, `no_effect`, `unknown`, `not_applicable`. Only `confirmed` can and must
have a confirmed-effect level, and it requires a successful syscall. SQL success
alone is insufficient to infer a changed file: the classifier must still apply
the catalog's evidence rules. Impact 0 is observation, 1 creation, 2 modification,
3 removal/replacement. Impact is not maliciousness or a security risk score.

### File context — 4 tables

| Table | Fields and meaning |
| --- | --- |
| `file_objects` | `id` PK; `sandbox_id` FK; `object_type`; `filesystem_identity?`; `inode_number?`; `generation?`; `identity_basis`; `first_seen_ns`; `last_seen_ns`. |
| `file_operation_targets` | `id` PK; `syscall_call_id` and `sandbox_id` form a scoped FK; `sandbox_id` also references sandbox; `file_object_id?` scoped FK; `target_role`; `supplied_path?`; `observed_path?`; `dirfd?`; `fd?`; `base_path?`; `resolution_status`; `identity_basis_json?`. |
| `file_labels` | `id` PK; `label`; `description`. |
| `file_label_assignments` | `id` PK; `target_id` FK; `label_id` FK; `basis` source of label; `confidence`; `rule_version`; `reason`; `assigned_at_ms`. |

Object types: `regular`, `directory`, `symlink`, `pipe`, `socket`, `device`,
`unknown`. Filesystem identity, inode, and generation are opaque text; none alone
is a global permanent identity. Paths can be reused, and multiple hard links can
refer to one object. Do not merge objects without supporting evidence.

Targets can be `target`, `source`, `destination`, or `replaced_destination`;
rename/copy can reference multiple rows. A missing object ID does not discard a
path observation. File objects and calls must belong to the target's sandbox.
Resolution states: `unresolved`, `supplied_only`, `lexical`, `runtime_resolved`.
Supplied-only requires a supplied path; lexical/resolved requires an observed
path. Lexical joining is not actual resolution through symlinks. Negative `dirfd`
values accommodate special constants such as `AT_FDCWD`; ordinary FDs are
nonnegative. No uniqueness constraint makes pathname an identity.

Labels initially include source code, configuration, potentially sensitive,
documentation, generated output, and temporary. Assignment confidence uses
`exact`, `corroborated`, `inferred`; basis might be `user`, `filename_rule`, or
`content_inspection`. Multiple labels are allowed. Labels attach to target
observations so a rename need not rewrite historical labels. This step performs
no content inspection or automatic labeling.

### Shared storage — 2 tables

| Table | Fields and meaning |
| --- | --- |
| `agent_payloads` | `sha` PK, SHA-256 supplied by the writer; `content` validated JSON text. Shared despite its existing agent-prefixed name. |
| `agent_context_items` | composite PK `(exchange_id, position)`; `exchange_id` FK; nonnegative `position`; `role?`; `kind?`; `external_call_id?`; `payload_sha` FK; `preview?`. |

Context items preserve conversation ordering; external call IDs are reported
identifiers, not automatic runtime links. JSON strings represent plain text.
Writers must redact before hashing/storage and verify hashes; SQL cannot redact
or independently calculate SHA-256. Retained runtime packets must still obey
existing environment/secret withholding rules. No buffer contents are required.

## Example investigation query

This joins a selected syscall reconstruction to accepted tool attribution,
classification, targets, and optional labels. Supplying the chosen reconstruction
and classifier version avoids silently aggregating alternative snapshots.

```sql
SELECT tc.id AS tool_call_id, tc.tool_name,
       sc.id AS syscall_call_id, sc.syscall_name, sc.outcome,
       p.pid, target.observed_path, target.supplied_path,
       category.label AS operation_category,
       result.operation_level, result.confirmed_effect_level,
       result.effect_status, labels.label AS file_label
FROM runtime_syscall_calls sc
LEFT JOIN runtime_processes p ON p.id = sc.process_id
LEFT JOIN runtime_attributions attribution
  ON attribution.event_id = sc.exit_event_id AND attribution.status = 'accepted'
LEFT JOIN agent_tool_calls tc ON tc.id = attribution.tool_call_id
LEFT JOIN classification_results result
  ON result.syscall_call_id = sc.id AND result.version_id = :version_id
LEFT JOIN classification_categories category ON category.id = result.category_id
LEFT JOIN file_operation_targets target ON target.syscall_call_id = sc.id
LEFT JOIN file_label_assignments assignment ON assignment.target_id = target.id
LEFT JOIN file_labels labels ON labels.id = assignment.label_id
WHERE sc.id = :syscall_call_id;
```

Multiple labels, classifications with different input hashes, or accepted
attributions can yield multiple rows; they are not additional syscall executions.
This query uses exit attribution; entry-only investigations can instead use
`entry_event_id`. Production code must select the intended classification input
and attribution rather than assuming all historical associations are current.

All domains live in one database here, so ordinary foreign keys work. A later
host/VM deployment split will require explicit replication and application-level
validation of cross-database relationships. Missing observations are not proof of
non-execution. These constraints preserve what is supplied; they cannot certify
collector completeness, resolve paths, or make untrusted input true.
