import { useNexus } from '../store';
import type { GraphEdge, GraphNode } from '../types/nexus';

const NODE_W = 168;
const NODE_H = 36;
const COL_GAP = 56;
const ROW_GAP = 14;
const PAD = 12;

const ICON: Record<GraphNode['kind'], string> = {
  anomaly: 'σ',
  alert: '▲',
  sensor: '◉',
  room: '▭',
  floor: '≡',
  asset: '⚙',
};

function columnOf(n: GraphNode): number {
  if (n.kind === 'floor' || n.kind === 'room' || n.kind === 'asset') return 0;
  if (n.kind === 'sensor') return 1;
  if (n.focus) return 2;
  return 3;
}

export interface PlacedNode extends GraphNode {
  x: number;
  y: number;
}

/** Deterministic four-column layout: structure | sensors | the anomaly | co-occurring events. */
export function layoutGraph(nodes: GraphNode[]): {
  placed: PlacedNode[];
  width: number;
  height: number;
} {
  const cols: GraphNode[][] = [[], [], [], []];
  for (const n of nodes) cols[columnOf(n)].push(n);
  const tallest = Math.max(1, ...cols.map(c => c.length));
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP;
  const placed: PlacedNode[] = [];
  cols.forEach((col, ci) => {
    const colHeight = col.length * NODE_H + Math.max(0, col.length - 1) * ROW_GAP;
    const top = (height - colHeight) / 2;
    col.forEach((n, ri) =>
      placed.push({ ...n, x: PAD + ci * (NODE_W + COL_GAP), y: top + ri * (NODE_H + ROW_GAP) })
    );
  });
  return { placed, width: PAD * 2 + 4 * NODE_W + 3 * COL_GAP, height };
}

/**
 * Node-link view of what is near an anomaly. Edges are drawn and labelled as exactly one of:
 *  - structural: the building topology says these are connected
 *  - temporal co-occurrence: these happened within the same window
 * Nothing here is, or is called, a cause.
 */
export function CausalGraph({
  nodes,
  edges,
  disclaimer,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  disclaimer: string;
}) {
  const select = useNexus(s => s.select);
  const { placed, width, height } = layoutGraph(nodes);
  const byId = new Map(placed.map(n => [n.id, n]));

  const open = (n: GraphNode) => {
    const [kind, raw] = n.id.split(':');
    if (kind === 'anomaly') select({ anomalyId: Number(raw), alertId: null });
    else if (kind === 'alert') select({ alertId: Number(raw), anomalyId: null });
    else if (kind === 'sensor') select({ sensor: raw, anomalyId: null, alertId: null });
    else if (kind === 'room') select({ room: raw, anomalyId: null, alertId: null });
  };

  return (
    <figure className="graph">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label="Investigation graph: structural and timing relationships"
        style={{ width: '100%', height: Math.min(height, 360) }}
      >
        {edges.map(e => {
          const a = byId.get(e.source);
          const b = byId.get(e.target);
          if (!a || !b) return null;
          const forward = a.x <= b.x;
          const x1 = forward ? a.x + NODE_W : a.x;
          const x2 = forward ? b.x : b.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const y2 = b.y + NODE_H / 2;
          const mx = (x1 + x2) / 2;
          return (
            <g key={e.id} className={`edge ${e.kind}`}>
              <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" />
              <text x={mx} y={(y1 + y2) / 2 - 4} textAnchor="middle">
                {e.kind === 'temporal_cooccurrence' ? `⏱ ${e.label}` : e.label}
              </text>
            </g>
          );
        })}
        {placed.map(n => (
          <g
            key={n.id}
            className={`gnode ${n.kind} ${n.focus ? 'focus' : ''}`}
            transform={`translate(${n.x},${n.y})`}
            tabIndex={0}
            role="button"
            aria-label={`${n.kind}: ${n.label}`}
            onClick={() => open(n)}
            onKeyDown={ev => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                open(n);
              }
            }}
          >
            <title>{`${n.kind}: ${n.label}${n.status ? ` (${n.status})` : ''}`}</title>
            <rect width={NODE_W} height={NODE_H} rx={8} />
            <text x={10} y={NODE_H / 2 + 4} className="gicon">
              {ICON[n.kind]}
            </text>
            <text x={28} y={NODE_H / 2 + 4}>
              {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="graph-legend">
        <span>
          <svg width="28" height="8" aria-hidden="true">
            <line x1="0" x2="28" y1="4" y2="4" className="legend-structural" />
          </svg>{' '}
          Structural (building topology)
        </span>
        <span>
          <svg width="28" height="8" aria-hidden="true">
            <line x1="0" x2="28" y1="4" y2="4" className="legend-temporal" />
          </svg>{' '}
          ⏱ Temporal co-occurrence (same time window)
        </span>
        <p className="dim">{disclaimer}</p>
      </figcaption>
    </figure>
  );
}
