import { createHash, randomUUID } from 'node:crypto';

export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const callTypes = new Set(['function_call', 'custom_tool_call', 'tool_use']);
const resultTypes = new Set(['function_call_output', 'custom_tool_call_output', 'tool_result']);
export const textOf = (item) => typeof item?.content === 'string' ? item.content : Array.isArray(item?.content) ? item.content.map((part) => part.text || '').join('\n') : item?.text || '';
const clip = (value, max = 220) => String(value).slice(0, max);

const plainOutput = (value) => typeof value === 'string' ? value : Array.isArray(value) ? value.map((part) => part?.text || '').filter(Boolean).join('\n') : JSON.stringify(value ?? '');
const shortPath = (path) => path.trim().split('/').filter(Boolean).slice(-3).join('/');
// Codex wraps tool work in a node-REPL script; recover what the call actually
// did (file operations, or the underlying shell command) for human display.
export function describeCall(argsRaw) {
  let script = String(argsRaw ?? '');
  try { const parsed = JSON.parse(script); script = String(parsed.script ?? parsed.cmd ?? parsed.command ?? parsed.input ?? script); } catch { /* raw string args */ }
  if (/apply_patch/.test(script)) {
    const verbs = { Add: 'created', Update: 'edited', Delete: 'deleted' };
    const ops = [...script.matchAll(/\*{3} (Add|Update|Delete) File: ?([^\n"\\]+)/g)].map(([, verb, path]) => `${verbs[verb]} ${shortPath(path)}`);
    return ops.length ? `${ops.slice(0, 3).join(', ')}${ops.length > 3 ? ` and ${ops.length - 3} more files` : ''}` : 'applied a file patch';
  }
  const shell = script.match(/(?:exec|run|shell|bash)\(\s*["'`]([^"'`]+)/) || script.match(/^\s*([^\n(]{4,})/);
  const line = (shell?.[1] || script).split(/\\n|\n/).map((part) => part.trim()).find((part) => part.length > 5 && !/^(text|await|const|let|var|import|return)\b/.test(part));
  return line ? `ran: ${clip(line, 90)}` : 'ran a script';
}
export function evidenceFor(payload, exchangeId) {
  if (!Array.isArray(payload?.input)) return [];
  return payload.input.flatMap((item, index) => {
    const isResult = resultTypes.has(item.type);
    if (!isResult && !((item.type === 'message' || !item.type) && item.role)) return [];
    const content = isResult ? plainOutput(item.output) : textOf(item);
    const preview = clip(content);
    const call = isResult ? payload.input.slice(0, index).findLast((prior) => prior.call_id === item.call_id && callTypes.has(prior.type)) : null;
    const role = isResult ? 'tool result' : item.role;
    return [{ id: `${exchangeId}:${index}`, exchange_id: exchangeId, index, kind: role,
      label: `#${index + 1} · ${call?.name || role}`, preview, content,
      intervention: isResult ? 'blank tool output; preserve call ID' : 'remove message',
      later_items: payload.input.length - index - 1,
      call_id: isResult ? item.call_id ?? null : null,
      action: call ? describeCall(call.arguments || call.input || '') : null,
      succeeded: isResult ? !/Script failed|command not found|Traceback|^Error:/im.test(content) : null,
      source_call: call ? { name: call.name, arguments: clip(call.arguments || call.input || '', 600) } : null }];
  });
}

export function replayEligibility(entry) {
  if (!['openai', 'openrouter'].includes(entry.provider) || !entry.route?.endsWith('/responses')) return 'Trials currently support OpenAI and OpenRouter Responses captures only.';
  if (!Array.isArray(entry.payload?.input)) return 'A full array of captured input items is required.';
  if (entry.payload.previous_response_id || entry.payload.conversation) return 'This request depends on server-side conversation state; a standalone snapshot is required.';
  if (!Array.isArray(entry.response?.output) || entry.response.status !== 'completed') return 'A completed captured response is required.';
  const safeTools = (tools) => Array.isArray(tools) && tools.every((tool) => tool.type === 'namespace' ? safeTools(tool.tools) : ['function', 'custom'].includes(tool.type));
  const toolGroups = [entry.payload.tools || [], ...entry.payload.input.filter((item) => item.tools).map((item) => item.tools)];
  if (!toolGroups.every(safeTools)) return 'This snapshot has server-executed tools. Replay requires function/custom tools only.';
  return null;
}

export function makeVariant(payload, evidence) {
  const copy = structuredClone(payload);
  const item = copy.input[evidence.index];
  if (!item) throw new Error('Evidence does not exist in this snapshot.');
  if (resultTypes.has(item.type)) item.output = '';
  else copy.input.splice(evidence.index, 1);
  return copy;
}

function canonical(value) {
  if (typeof value === 'string') { try { return canonical(JSON.parse(value)); } catch { return value; } }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function outcome(payload) {
  if (!Array.isArray(payload?.output) || payload.status !== 'completed') throw new Error('Response is incomplete or unrecognized; excluded from decision counts.');
  const calls = payload.output.filter((item) => callTypes.has(item.type)).map((item) => ({ name: item.name, arguments: item.arguments ?? item.input ?? '' }));
  const text = payload.output.filter((item) => item.type === 'message').map(textOf).join('\n');
  if (!calls.length && !text) throw new Error('No observable decision in response; excluded from decision counts.');
  const first = calls[0];
  return { calls, text, key: first ? digest({ name: first.name, arguments: canonical(first.arguments) }) : 'answer',
    label: first ? `${first.name}: ${clip(typeof first.arguments === 'string' ? first.arguments : JSON.stringify(first.arguments), 140)}` : 'Text answer',
    usage: payload.usage || null };
}

export function validateTarget(target, recorded) {
  if (target?.type === 'original_action' && recorded.calls.length) return { type: target.type, key: recorded.key, label: `First proposed call matches: ${recorded.label}` };
  if (target?.type === 'tool_contains' && typeof target.name === 'string' && target.name.trim() && typeof target.contains === 'string' && target.contains.trim()) {
    if (target.name.length > 160 || target.contains.length > 500) throw new Error('Target is too long.');
    return { type: target.type, name: target.name.trim(), contains: target.contains.trim(), label: `First call ${target.name.trim()} contains “${target.contains.trim()}”` };
  }
  if (target?.type === 'answer_contains' && typeof target.contains === 'string' && target.contains.trim() && target.contains.length <= 500) return { type: target.type, contains: target.contains.trim(), label: `Answer contains “${target.contains.trim()}” (case-insensitive)` };
  throw new Error('Choose an explicit target: original first call, first tool plus argument text, or answer phrase.');
}
export function matchesTarget(result, target) {
  if (target.type === 'original_action') return result.key === target.key;
  if (target.type === 'answer_contains') return result.text.toLowerCase().includes(target.contains.toLowerCase());
  const first = result.calls[0];
  return !!first && first.name === target.name && (typeof first.arguments === 'string' ? first.arguments : JSON.stringify(first.arguments)).includes(target.contains);
}

// Wilson score intervals for Bernoulli event frequencies, including 0/n and n/n.
export function wilson(hits, total) {
  if (!total) return null;
  const z = 1.959963984540054; const p = hits / total; const d = 1 + z * z / total;
  const mid = (p + z * z / (2 * total)) / d;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}
function armSummary(trials, arm) {
  const runs = trials.filter((trial) => trial.arm === arm); const valid = runs.filter((trial) => trial.status === 'succeeded');
  const hits = valid.filter((trial) => trial.matches).length;
  const distribution = new Map();
  for (const trial of valid) { const bucket = distribution.get(trial.outcome.key) || { label: trial.outcome.label, count: 0 }; bucket.count++; distribution.set(trial.outcome.key, bucket); }
  return { attempted: runs.length, successful: valid.length, failed: runs.length - valid.length, hits,
    rate: valid.length ? hits / valid.length : null, interval: wilson(hits, valid.length),
    distribution: [...distribution.values()].sort((a, b) => b.count - a.count).map((item) => ({ ...item, rate: item.count / valid.length })) };
}
export function summarize(trials) {
  const baseline = armSummary(trials, 'baseline'); const intervention = armSummary(trials, 'intervention');
  let effect = null;
  if (baseline.interval && intervention.interval) {
    const difference = baseline.rate - intervention.rate;
    // Newcombe hybrid-score interval for independent proportions (baseline minus intervention).
    const low = difference - Math.hypot(baseline.rate - baseline.interval[0], intervention.interval[1] - intervention.rate);
    const high = difference + Math.hypot(baseline.interval[1] - baseline.rate, intervention.rate - intervention.interval[0]);
    effect = { difference, interval: [Math.max(-1, low), Math.min(1, high)],
      interpretation: low > 0 ? 'Withholding this item reduced the target frequency in these trials.' : high < 0 ? 'Withholding this item increased the target frequency in these trials.' : 'The interval includes zero; these trials do not resolve the direction of influence.' };
  }
  return { baseline, intervention, effect };
}

export function createExperiment(entry, config) {
  const reason = replayEligibility(entry); if (reason) throw new Error(reason);
  if (!Number.isInteger(config.repetitions) || config.repetitions < 2 || config.repetitions > 20) throw new Error('Choose 2–20 trials per condition.');
  const evidence = evidenceFor(entry.payload, config.exchange_id).find((item) => item.id === config.evidence_id);
  if (!evidence) throw new Error('Select evidence from this exact request.');
  const recorded = outcome(entry.response); const target = validateTarget(config.target, recorded);
  return { id: randomUUID(), exchange_id: config.exchange_id, created_at: new Date().toISOString(), status: 'queued',
    model: entry.payload.model, reasoning: entry.payload.reasoning || null, repetitions: config.repetitions,
    max_requests: config.repetitions * 2, snapshot_hash: digest(entry.payload), variant_hash: digest(makeVariant(entry.payload, evidence)),
    removed: evidence, target, hypothesis: `This context item helps produce the target: ${target.label}.`, recorded,
    trials: [], summary: summarize([]), caveats: [
      'Frequencies describe repeated next responses under this snapshot, model, and target definition.',
      '95% intervals assume independent trials and stable model behavior; shared infrastructure can violate these assumptions.',
      'Exact call matching includes arguments; phrase matching is lexical, not a semantic truth judgment.',
      'Later messages and opaque model state are retained and may repeat this evidence. Use the earliest request before the decision to test selection.',
      'Tool calls are proposals only. No local tools run and no continuation to final task completion is performed.',
      'Alternative explanations include redundant context, prior model knowledge, wording sensitivity, and ordinary sampling variation.'
    ] };
}

export async function runExperiment(job, entry, { invoke, onUpdate = async () => {}, signal, random = Math.random }) {
  const variant = makeVariant(entry.payload, job.removed);
  job.status = 'running'; await onUpdate(job);
  for (let pair = 0; pair < job.repetitions; pair++) {
    const order = random() < 0.5 ? ['baseline', 'intervention'] : ['intervention', 'baseline'];
    for (const arm of order) {
      if (signal?.aborted) break;
      const started = Date.now();
      try {
        const response = await invoke(structuredClone(arm === 'baseline' ? entry.payload : variant), signal);
        const result = outcome(response);
        job.trials.push({ arm, pair, status: 'succeeded', duration_ms: Date.now() - started, outcome: result, matches: matchesTarget(result, job.target) });
      } catch (error) {
        job.trials.push({ arm, pair, status: 'failed', duration_ms: Date.now() - started, error: error.message });
      }
      job.summary = summarize(job.trials); await onUpdate(job);
      // Abort costly batches after provider errors; partial data is explicitly marked.
      if (job.trials.at(-1).status === 'failed') { job.status = signal?.aborted ? 'cancelled' : 'failed'; break; }
    }
    if (signal?.aborted || job.status === 'failed' || job.status === 'cancelled') break;
  }
  job.status = signal?.aborted ? 'cancelled' : job.status === 'failed' ? 'failed' : 'completed';
  job.completed_at = new Date().toISOString(); await onUpdate(job);
  return job;
}
