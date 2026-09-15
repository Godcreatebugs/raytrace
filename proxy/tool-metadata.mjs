// Remove only the runner's header, not identifiers inside actual command output.
export function toolResultStatus(item) {
  const output = item.output ?? item.content;
  if (item.is_error === true || item.status === 'failed') return 'Failed';
  const code = item.exit_code ?? (output && typeof output === 'object' && !Array.isArray(output) ? output.exit_code : undefined);
  if (typeof code === 'number') return code === 0 ? 'Successful' : 'Failed';
  const text = typeof output === 'string' ? output : Array.isArray(output) ? output.map(part => part?.text || '').join('\n') : '';
  // Read runner metadata only, never infer failure from file contents or logs.
  const header = text.split(/^Output:\s*$/m)[0].slice(0, 1000);
  if (/^(?:Chunk ID: [\w-]+\r?\n)?Wall time:/i.test(text)) {
    const exit = header.match(/^Process exited with code (-?\d+)\s*$/m);
    if (exit) return Number(exit[1]) === 0 ? 'Successful' : 'Failed';
    if (/^Process running with session ID /m.test(header)) return 'Still running';
  }
  if (/^Script failed\b/.test(text)) return 'Failed';
  if (/^Script completed\b/.test(text)) return 'Successful';
  if (item.status === 'omitted' || item.omitted === true) return 'Output omitted';
  if (item.status === 'cancelled') return 'Cancelled';
  if (item.status === 'in_progress') return 'Still running';
  if (output == null || output === '') return 'No output';
  return 'Result received';
}

export function stripChunkHeader(text) {
  return typeof text === 'string'
    ? text.replace(/^Chunk ID: [a-zA-Z0-9_-]+\r?\n(?=Wall time:)/, '')
    : text;
}

export function omitToolChunkIds(value) {
  if (Array.isArray(value)) return value.map(omitToolChunkIds);
  if (!value || typeof value !== 'object') return value;
  const toolOutput = ['function_call_output', 'custom_tool_call_output', 'tool_result'].includes(value.type);
  const evidence = value.kind === 'tool result';
  return Object.fromEntries(Object.entries(value).filter(([key]) => !(toolOutput && key === 'chunk_id')).map(([key, item]) => {
    if ((toolOutput && ['output', 'content'].includes(key)) || (evidence && ['content', 'preview'].includes(key))) {
      if (Array.isArray(item)) return [key, item.map(part => part && typeof part === 'object' ? { ...part, ...(typeof part.text === 'string' ? { text: stripChunkHeader(part.text) } : {}) } : part)];
      return [key, stripChunkHeader(item)];
    }
    return [key, omitToolChunkIds(item)];
  }));
}
