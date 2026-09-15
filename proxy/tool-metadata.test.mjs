import test from 'node:test';
import assert from 'node:assert/strict';
import { omitToolChunkIds, toolResultStatus } from './tool-metadata.mjs';
const output = 'Chunk ID: 259a39\nWall time: 0.001 seconds\nProcess exited with code 0\nOutput:\nChunk ID: actual-file-content';
test('summarize execution status without exposing output or misreading file contents', () => {
  assert.equal(toolResultStatus({ output }), 'Successful');
  assert.equal(toolResultStatus({ output: output.replace('code 0', 'code 1') }), 'Failed');
  assert.equal(toolResultStatus({ output: 'Wall time: 0.1 seconds\nProcess running with session ID 123\nOutput:\n' }), 'Still running');
  assert.equal(toolResultStatus({ output: 'a file containing\nProcess exited with code 1' }), 'Result received');
  assert.equal(toolResultStatus({ omitted: true }), 'Output omitted');
  assert.equal(toolResultStatus({ output: '' }), 'No output');
  assert.equal(toolResultStatus({ is_error: true, output: 'details' }), 'Failed');
});
test('remove runner chunk headers while preserving correlation IDs, content, and original payload', () => {
  const original = { input: [{ type: 'function_call_output', call_id: 'call_123', chunk_id: '259a39', output }, { role: 'user', content: output }] };
  const cleaned = omitToolChunkIds(original);
  assert.equal(cleaned.input[0].call_id, 'call_123'); assert.equal(cleaned.input[0].chunk_id, undefined);
  assert.ok(cleaned.input[0].output.startsWith('Wall time:')); assert.ok(cleaned.input[0].output.endsWith('Chunk ID: actual-file-content'));
  assert.equal(cleaned.input[1].content, output); assert.equal(original.input[0].output, output);
});
test('strip evidence previews and structured text tool results', () => {
  const evidence = omitToolChunkIds({ kind: 'tool result', content: output, preview: output });
  assert.ok(evidence.content.startsWith('Wall time:')); assert.ok(evidence.preview.startsWith('Wall time:'));
  const item = omitToolChunkIds({ type: 'tool_result', content: [{ type: 'text', text: output }] });
  assert.ok(item.content[0].text.startsWith('Wall time:'));
});
