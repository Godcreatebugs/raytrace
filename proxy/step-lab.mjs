import { randomUUID } from 'node:crypto';
import { evidenceFor, outcome, replayEligibility, digest, summarize } from './experiment-engine.mjs';

export function inspectStep(entry, exchangeId, index) {
  const item = entry.response?.output?.[index];
  if (!item || !['function_call', 'custom_tool_call', 'message'].includes(item.type)) throw new Error('Select a model answer or proposed tool call.');
  const decision = outcome({ status: 'completed', output: [item] });
  const terms = [...new Set(JSON.stringify(item.arguments ?? item.input ?? '').match(/[\w-]+\.[a-zA-Z]{1,8}|[a-zA-Z_$][\w$]{3,}(?=\s*\()/g) || [])];
  const evidence = evidenceFor(entry.payload, exchangeId);
  const ranked = evidence.map((source) => {
    const matched = terms.filter((term) => source.content.includes(term));
    return { source, matched, score: matched.length * 10 + (source.kind === 'tool result' ? 2 : source.kind === 'user' ? 1 : 0) };
  }).filter(({ source }) => source.content.trim()).sort((a, b) => b.score - a.score || b.source.index - a.source.index).slice(0, 3);
  return { exchange_id: exchangeId, output_index: index, model: entry.payload.model, decision,
    replay_reason: replayEligibility(entry), evidence,
    hypotheses: ranked.map(({ source, matched }) => ({ evidence_id: source.id,
      title: matched.length ? `A prior context item mentions ${matched.slice(0, 2).join(', ')}` : source.kind === 'tool result' ? 'An earlier tool result may have guided the next action' : source.kind === 'user' ? 'The user request may have directed this action' : 'Instructions may have shaped the approach',
      explanation: matched.length ? 'This reference was already available before the selected action. Test its influence by editing or withholding it.' : 'This context was available, but no direct file or function reference was found. This is a weaker hypothesis.',
      excerpt: matched.length ? source.content.slice(Math.max(0, source.content.indexOf(matched[0]) - 80), source.content.indexOf(matched[0]) + 220) : source.preview,
    })) };
}

export function editedPayload(entry, config) {
  const source = evidenceFor(entry.payload, config.exchange_id).find((item) => item.id === config.evidence_id);
  if (!source) throw new Error('Choose context from this step.');
  if (typeof config.context !== 'string' || Buffer.byteLength(config.context) > 500_000) throw new Error('Edited context must be text under 500 KB.');
  const payload = structuredClone(entry.payload);
  const item = payload.input[source.index];
  if (source.kind === 'tool result') item.output = config.context;
  else {
    if (Array.isArray(item.content) && item.content.some((part) => !['text', 'input_text', 'output_text'].includes(part.type))) throw new Error('This context includes non-text content and cannot be edited here.');
    item.content = config.context;
  }
  return payload;
}

export function createStepRun(entry, config, model) {
  const step = inspectStep(entry, config.exchange_id, config.output_index);
  if (step.replay_reason) throw new Error(step.replay_reason);
  if (!['decision', 'execute'].includes(config.mode)) throw new Error('Choose a run mode.');
  if (!Number.isInteger(config.repetitions) || config.repetitions < 2 || config.repetitions > 20) throw new Error('Runs per version must be 2–20.');
  const variant = editedPayload(entry, config);
  if (model !== entry.payload.model && entry.payload.input.some((item) => item.type === 'reasoning' || item.type === 'item_reference')) throw new Error('This snapshot contains model-specific state. Choose the original model or capture a fresh text/tool-only request.');
  variant.model = model;
  const baseline = { ...structuredClone(entry.payload), model };
  if (!Number.isInteger(config.max_requests) || config.max_requests < 1 || config.max_requests > 20) throw new Error('Execution limit must be 1–20 model requests.');
  return { job: { id: randomUUID(), kind: 'step', mode: config.mode, exchange_id: config.exchange_id, output_index: config.output_index,
    evidence_id: config.evidence_id, model, created_at: new Date().toISOString(), status: 'queued', recorded: step.decision,
    repetitions: config.repetitions, max_requests: config.mode === 'execute' ? config.max_requests : config.repetitions * 2,
    context_hash: digest(variant), trials: [], events: [], summary: summarize([]), cost: 0 }, baseline, variant };
}

export function selectedActionMatches(response, recorded) {
  if (recorded.calls.length) return (response.output || []).some((item) => {
    if (!['function_call', 'custom_tool_call'].includes(item.type)) return false;
    return outcome({ status: 'completed', output: [item] }).key === recorded.key;
  });
  return outcome(response).text === recorded.text;
}

export async function runDecision(job, baseline, variant, invoke, signal) {
  job.status = 'running';
  for (let pair = 0; pair < job.repetitions; pair++) {
    for (const arm of (Math.random() < 0.5 ? ['baseline', 'intervention'] : ['intervention', 'baseline'])) {
      if (signal.aborted) { job.status = 'cancelled'; return; }
      try {
        const response = await invoke(structuredClone(arm === 'baseline' ? baseline : variant), signal);
        job.cost += Number(response.usage?.cost) || 0;
        job.trials.push({ pair, arm, status: 'succeeded', outcome: outcome(response), matches: selectedActionMatches(response, job.recorded) });
      } catch (error) {
        job.trials.push({ pair, arm, status: 'failed', error: error.message });
        job.status = signal.aborted ? 'cancelled' : 'failed'; job.summary = summarize(job.trials); return;
      }
      job.summary = summarize(job.trials);
    }
  }
  job.status = 'completed';
}
