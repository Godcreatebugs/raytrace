// Shared types for the captured-trace UI. Consolidated out of the old
// experiment-lab.tsx (removed) so there is one home for these instead of
// three files each importing from whichever file happened to define them.

import { type RequestMetric } from './request-metrics';

export type Origin = { trace_id: string; exchange_id: string; name: string };

export type EventKind = 'model' | 'search' | 'read' | 'edit' | 'test';
export type TraceEvent = { kind: EventKind; title: string; detail: string; time: string; raw: string; exchange_id?: string; output_index?: number };

/** Ground truth for one proposed tool call, independent of whether its
 * result was ever resent as evidence in a later request (a call in the very
 * last response of a trace never is, since there's no later request to
 * resend it into) — see readTraces()'s callVerifications in raytace-proxy.mjs. */
export type CallVerification = {
  call_id: string;
  exchange_id: string;
  name: string;
  verified: boolean;
  status: string | null;
  error: string | null;
  match_score: number | null;
  /** 'window': command text matched inside the call's causal window (after
   * the proposing request started, before its result was sent back). */
  match_basis: 'id' | 'text' | 'window' | null;
  /** Which witness observed the execution: 'gvisor' (the sandbox's
   * SecCheck stream) is the only one. */
  source?: string | null;
  /** True when the sandbox runtime (gVisor) saw this program start,
   * independent of anything the agent logged about itself. */
  kernel_confirmed?: boolean;
  tier?: Tier | null;
  reported_check?: ReportedCheck | null;
  descendant_count?: number;
  /** Position of the call in its response; with exchange_id, finds its step. */
  output_index?: number;
  /** The command the model proposed, without the shell wrapper. */
  proposed?: string | null;
  descendants?: Descendant[];
} & ExecutionFields;

/** The sandbox process a call actually ran as (runtime_processes, through
 * its accepted attribution). Every field is null when nothing was observed
 * for the call. Times are the proxy's clock; `window_*` are the causal window
 * that justified a 'window' match (runtime_attributions). */
export type ExecutionFields = {
  exec_id?: string | null;
  pid?: number | null;
  start_time_ns?: string | null;
  argv?: string[] | null;
  started_at?: string | null;
  ended_at?: string | null;
  exit_code?: number | null;
  window_start_ms?: number | null;
  window_end_ms?: number | null;
};

/** The agent's own report of a finished call (runner exit code and wall
 * time) against what the runtime observed — runtime_attributions.reported_check.
 * Null when not comparable. */
export type ReportedCheck = 'agrees' | 'exit_code_differs' | 'duration_differs';

/** How an execution was attributed to the call it appears under, recorded at
 * capture and never recomputed by a later join (runtime_attributions
 * confidence: exact → mediated, corroborated, inferred).
 *
 *  mediated     the call id travelled with the process (RAYTRACE_CALL_ID)
 *  corroborated a text match an independent kernel witness also saw
 *  inferred     a command-text match inside a time window, nothing more
 *  unverified   it ran; it matched no proposed call
 */
export type Tier = 'mediated' | 'corroborated' | 'inferred' | 'unverified';

/** One process that ran underneath a proposed call — npm test's pretest hook,
 * and whatever that spawned. Never a proposed call itself: nothing in
 * `tool_calls` corresponds to it, which is why these were discarded before
 * migration 005 gave them a row shape. */
export type Descendant = {
  id: string;
  tier: Tier;
  pid: number | null;
  ppid: number | null;
  start_time_ns?: string | null;
  argv: string[];
  status: string | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
};

export type SummaryState = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'error' };

/** One "Model request #N" grouping in a trace's flat event list — the same
 * grouping app/page.tsx's timeline renders, reused by the graph view so the
 * two stay in lockstep instead of each re-deriving it slightly differently. */
export type TraceBlock = { exchangeId: string; number: number; completion?: TraceEvent; items: { event: TraceEvent; index: number }[] };

export type Trace = {
  sandboxId?: string;
  requests?: RequestMetric[];
  id: string;
  provider: string;
  model: string;
  title: string;
  startedAt: string;
  /** When the turn's last response landed. */
  endedAt?: string;
  /** The turn's final answer text, when the last response had any. */
  answer?: string;
  events: TraceEvent[];
  evidence: ContextItem[];
  callVerifications?: CallVerification[];
};

/** One piece of context sent into a model request (a message, instructions,
 * or a tool result) plus what the counterfactual lab knows about it. */
export type ContextItem = {
  id: string;
  exchange_id: string;
  index: number;
  kind: string;
  label: string;
  preview: string;
  content?: string;
  intervention: string;
  later_items: number;
  call_id: string | null;
  origin: Origin | null;
  action: string | null;
  succeeded: boolean | null;
  source_call: { name: string; arguments: string } | null;
  /** Real ground truth from Codex's own execution log, correlated by call_id
   * (see proxy/execution-correlation.mjs). Absent/undefined for older
   * captures or calls the correlator hasn't resolved — fall back to
   * `succeeded` (the text-scanning heuristic) in that case. */
  verified?: boolean;
  real_outcome?: string | null;
  real_status?: string | null;
  real_error?: string | null;
  match_score?: number | null;
  match_basis?: 'id' | 'text' | 'window' | null;
  reported_check?: ReportedCheck | null;
  source?: string | null;
  kernel_confirmed?: boolean;
  /** Attribution strength for this call's own execution row. */
  tier?: Tier | null;
  /** Processes that ran underneath this call — empty until a collector that
   * records them has run (the gVisor forwarder; see step 3). */
  descendants?: Descendant[];
  descendant_count?: number;
} & ExecutionFields;

export type Outcome = { key: string; label: string; calls: { name: string; arguments: unknown }[]; text: string };

/** The state of one model request just before it was sent. */
export type Snapshot = {
  exchange_id: string;
  model: string;
  stream: boolean;
  input_items: number;
  tool_count: number;
  reasoning?: { effort?: string; context?: string };
  replay_reason: string | null;
  decision: Outcome | null;
};
