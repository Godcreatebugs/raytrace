'use client';

// A graph view of one trace: one node per "Model request #N", connected in
// sequence, each edge annotated with whether the tool call(s) that request
// proposed were actually confirmed executed (real ground truth from
// proxy/execution-correlation.mjs — see raytace-proxy.mjs's readTraces()
// callVerifications), not a text-scanning guess.
//
// Deliberately sequential-only for now: Codex resends the FULL conversation
// history on every turn, so naively drawing an edge for every place a past
// tool result reappears as input would mean O(N^2) near-duplicate edges —
// virtually every call ends up "present" in virtually every later request.
// trace.callVerifications sidesteps that: it's one entry per call keyed by
// the exchange that originally proposed it, so grouping by origin exchange
// gives exactly "what did request N introduce" without needing to reason
// about resend noise at all.
import { useMemo } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, type Node, type Edge, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { type Trace, type TraceBlock, type SummaryState } from './types';
import { completionFailed } from './trace-utils';
import { money, duration } from './request-metrics';

const NODE_WIDTH = 236;
const NODE_SPACING = 300;

type NodeData = {
  number: number;
  summaryText: string;
  summaryLoading: boolean;
  failed: boolean | null;
  cost: number | null;
  durationMs: number | null;
  verifiedCount: number;
  totalCalls: number;
  onClick: () => void;
};

function RequestNode({ data }: NodeProps<Node<NodeData>>) {
  const statusClass = data.failed === null ? '' : data.failed ? 'graph-node-fail' : 'graph-node-ok';
  return (
    <button type="button" className={`graph-node ${statusClass}`} onClick={data.onClick}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <div className="graph-node-head">
        <span className="graph-node-num">Request #{data.number}</span>
        {data.failed !== null && <span className={`graph-node-status ${data.failed ? 'fail' : 'ok'}`}>{data.failed ? 'Failed' : 'OK'}</span>}
      </div>
      <p className="graph-node-summary">{data.summaryLoading ? 'Summarizing…' : data.summaryText || 'No summary yet.'}</p>
      <div className="graph-node-meta">
        <span>{money(data.cost)}</span>
        <span>{duration(data.durationMs)}</span>
        {data.totalCalls > 0 && <span className={data.verifiedCount === data.totalCalls ? 'graph-node-verified-all' : 'graph-node-verified-partial'}>{data.verifiedCount}/{data.totalCalls} verified</span>}
      </div>
    </button>
  );
}

const nodeTypes = { request: RequestNode };

export function TraceGraph({ trace, blocks, summaries, onSelectStep }: { trace: Trace; blocks: TraceBlock[]; summaries: Record<string, SummaryState>; onSelectStep: (index: number) => void }) {
  const { nodes, edges } = useMemo(() => {
    const requestMetricById = new Map((trace.requests || []).map((request) => [request.id, request]));
    const callsByExchangeId = new Map<string, { verified: boolean; name: string; status: string | null; match_score: number | null; match_basis: 'id' | 'text' | null }[]>();
    for (const call of trace.callVerifications || []) {
      const list = callsByExchangeId.get(call.exchange_id) || [];
      list.push({ verified: call.verified, name: call.name, status: call.status, match_score: call.match_score, match_basis: call.match_basis });
      callsByExchangeId.set(call.exchange_id, list);
    }

    const graphNodes: Node<NodeData>[] = blocks.map((block, index) => {
      const metric = requestMetricById.get(block.exchangeId);
      const summary = summaries[block.exchangeId];
      const calls = callsByExchangeId.get(block.exchangeId) || [];
      const failed = block.completion ? completionFailed(block.completion) : null;
      return {
        id: block.exchangeId,
        type: 'request',
        position: { x: index * NODE_SPACING, y: 0 },
        data: {
          number: block.number,
          summaryText: summary?.status === 'ready' ? summary.text : '',
          summaryLoading: summary?.status === 'loading',
          failed,
          cost: metric?.cost ?? null,
          durationMs: metric?.durationMs ?? null,
          verifiedCount: calls.filter((call) => call.verified).length,
          totalCalls: calls.length,
          onClick: () => onSelectStep(block.items[0]?.index ?? 0),
        },
        style: { width: NODE_WIDTH },
      };
    });

    const graphEdges: Edge[] = [];
    for (let i = 0; i < blocks.length - 1; i++) {
      const from = blocks[i];
      const to = blocks[i + 1];
      const calls = callsByExchangeId.get(from.exchangeId) || [];
      const verifiedCount = calls.filter((call) => call.verified).length;
      const allVerified = calls.length > 0 && verifiedCount === calls.length;
      const someVerified = verifiedCount > 0 && verifiedCount < calls.length;
      const label = calls.length ? `${verifiedCount}/${calls.length} verified` : undefined;
      graphEdges.push({
        id: `seq-${from.exchangeId}-${to.exchangeId}`,
        source: from.exchangeId,
        target: to.exchangeId,
        label,
        style: { stroke: allVerified ? '#3d7a5e' : someVerified ? '#8a7233' : calls.length ? '#7a3d45' : '#2a3951' },
        labelStyle: { fill: '#c7d4e8', fontSize: 10 },
        labelBgStyle: { fill: '#0d1726' },
      });
    }
    return { nodes: graphNodes, edges: graphEdges };
  }, [trace, blocks, summaries, onSelectStep]);

  if (!blocks.length) return <div className="graph-empty">No model requests captured for this trace yet.</div>;

  return (
    <div className="graph-canvas">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }} colorMode="dark">
        <Background color="#1d2b40" gap={24} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable style={{ background: '#0a1220' }} maskColor="rgba(9,17,30,0.75)" nodeColor="#1b2b42" />
      </ReactFlow>
    </div>
  );
}
