const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function requestMetrics(row) {
  const payload = row.response?.payload;
  const frames = payload?.events || [];
  const usage = payload?.usage || frames.findLast(e => e.usage || e.response?.usage)?.usage || frames.findLast(e => e.response?.usage)?.response?.usage || {};
  const elapsed = row.completed_at ? Date.parse(row.completed_at) - Date.parse(row.timestamp) : NaN;
  return {
    input: numeric(usage.input_tokens ?? usage.prompt_tokens),
    output: numeric(usage.output_tokens ?? usage.completion_tokens),
    cost: row.provider === 'openrouter' ? numeric(usage.cost) : null,
    durationMs: numeric(elapsed),
  };
}
