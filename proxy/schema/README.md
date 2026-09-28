# Agent-intent schema

For the complete database, see [the evidence database guide](EVIDENCE_DATABASE.md).
The agent-only import below remains available; the combined initializer loads
this schema plus runtime, classification, file context, shared conversation
storage and auxiliary tables.

`agent_intent.sql` defines four agent-domain tables and one shared payload table.
The proxy fills them as each model request is captured (`proxy/evidence-store.mjs`):
a session per agent session id, a turn per user prompt, an exchange per model
request, and a tool call per proposal, with the agent's reported result attached
when it sends that result back.

## Tables and rationale

| Table | One row represents | Why it exists |
| --- | --- | --- |
| `agent_sessions` | An agent conversation/session | Groups user turns; preserves the external session identifier without assuming global uniqueness. |
| `agent_turns` | One user request and the agent's response cycle | Groups multiple model exchanges into the unit the user wants to inspect. |
| `agent_exchanges` | One model API request/response | Retains provider/model metadata and payload references, even when the turn cannot yet be identified. |
| `agent_tool_calls` | One proposed tool invocation | Separates what the model requested and what the agent reported from independently observed execution. |
| `agent_payloads` | A serialized JSON payload | Deduplicates prompts, responses, arguments, and reported results without repeating large values in relational rows. |

The SQL file is the authoritative column/constraint definition. All internal IDs
are application-generated non-null text values. External session and call IDs
are not globally unique. An output position is unique within its exchange; a
turn sequence is unique within its session. Both are nonnegative integers.

An exchange always belongs to a session. Its `turn_id` may be null; when present,
the composite foreign key requires the turn to belong to the same session.
Unknown agent names, model names, and results remain null rather than invented.

Times are integer Unix epoch milliseconds. End times cannot precede start times.
Turn status defaults to `unknown`; other values are `active`, `completed`,
`failed`, and `cancelled`. Status describes the agent lifecycle, not whether a
sandbox command succeeded. Completing a turn does not establish that all child
processes exited. This schema does not enforce a status transition state machine.

**A reported tool result is not independent runtime evidence.** A tool proposal
with no result is valid, and missing results do not prove non-execution. There
are no runtime events, execution verdicts, syscall classifications, or file labels
in this domain.

## Import

Use SQLite with JSON functions (available in the project's `node:sqlite` runtime).
From the repository root:

```sh
agent_schema_dir=$(mktemp -d)
sqlite3 "$agent_schema_dir/agent_intent.db" < proxy/schema/agent_intent.sql
sqlite3 "$agent_schema_dir/agent_intent.db" '.schema'
```

Import outside an existing transaction. Creation is transactional and repeatable:
re-importing an unchanged schema preserves existing rows. `IF NOT EXISTS` is not
a schema upgrader; an incompatible future revision requires a fresh database or
an explicit migration. This script does not alter `PRAGMA user_version`.

Foreign keys must be enabled with `PRAGMA foreign_keys = ON` on **every** writer
connection. Referenced rows cannot be deleted while their dependants exist;
there are no cascading deletes.

## Payload convention

The future writer computes lowercase SHA-256 over the exact UTF-8 bytes of the
JSON text stored in `agent_payloads.content`. Use JSON strings for plain text:

```json
"Run the tests and tell me whether they pass."
```

SQL validates JSON syntax but does not compute or verify the hash. The writer
must verify the hash, reuse an existing matching payload, and never update a
payload in place under an unchanged hash. Semantically equivalent JSON with
different serialization can have different hashes. Redaction must happen before
hashing and persistence; this schema does not itself redact payloads.

## Example join

This shows a session's turns, exchanges, and proposed calls, including turns that
have no calls yet:

```sql
SELECT s.id AS session_id,
       t.id AS turn_id,
       t.sequence_number,
       e.id AS exchange_id,
       e.provider,
       e.model,
       c.id AS tool_call_id,
       c.tool_name,
       a.content AS proposed_arguments,
       r.content AS reported_result
FROM agent_sessions AS s
JOIN agent_turns AS t ON t.session_id = s.id
LEFT JOIN agent_exchanges AS e
       ON e.turn_id = t.id AND e.session_id = s.id
LEFT JOIN agent_tool_calls AS c ON c.exchange_id = e.id
LEFT JOIN agent_payloads AS a ON a.sha = c.arguments_sha
LEFT JOIN agent_payloads AS r ON r.sha = c.reported_result_sha
WHERE s.id = 'session-example'
ORDER BY t.sequence_number, e.started_at_ms, e.id, c.output_index;
```

Unresolved-turn exchanges are intentionally absent from that turn-based join.
Inspect them separately:

```sql
SELECT * FROM agent_exchanges
WHERE session_id = 'session-example' AND turn_id IS NULL
ORDER BY started_at_ms, id;
```

## Validation

```sh
node --disable-warning=ExperimentalWarning --test proxy/agent-intent-schema.test.mjs
```

Tests use isolated temporary databases and never open the live application DB.
