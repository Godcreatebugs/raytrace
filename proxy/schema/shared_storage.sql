-- agent_payloads is created by agent_intent.sql and is shared across domains.
CREATE TABLE agent_context_items (
 exchange_id TEXT NOT NULL REFERENCES agent_exchanges(id),
 position INTEGER NOT NULL CHECK (typeof(position)='integer' AND position>=0),
 role TEXT,
 kind TEXT,
 external_call_id TEXT,
 payload_sha TEXT NOT NULL REFERENCES agent_payloads(sha),
 preview TEXT,
 PRIMARY KEY(exchange_id, position)
);
CREATE INDEX agent_context_payload ON agent_context_items(payload_sha);
CREATE INDEX agent_context_external ON agent_context_items(exchange_id, external_call_id);
-- Finding the request that carried a call's result back (its causal window's end).
CREATE INDEX agent_context_call ON agent_context_items(external_call_id, kind);
CREATE INDEX agent_turn_prompt_payload ON agent_turns(user_prompt_sha);
CREATE INDEX agent_turn_response_payload ON agent_turns(final_response_sha);
CREATE INDEX agent_exchange_request_payload ON agent_exchanges(request_sha);
CREATE INDEX agent_exchange_response_payload ON agent_exchanges(response_sha);
CREATE INDEX agent_call_arguments_payload ON agent_tool_calls(arguments_sha);
CREATE INDEX agent_call_result_payload ON agent_tool_calls(reported_result_sha);
