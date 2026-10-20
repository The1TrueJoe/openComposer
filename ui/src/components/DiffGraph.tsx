import { useMemo } from "react";
import type { Change } from "../api";
import { affectedGraph, type GraphNode } from "../lib/diff";

const NODE_W = 178, NODE_H = 36, ROW = 50, COL_GAP = 120, PAD = 14;

/** The devices a change rewires, providers on the left and consumers on the right, with the
 *  connections being made (green) and broken (red, dotted when they go because a device went).
 *  A connection list says the same thing, but this is how somebody checks "is the TV still fed
 *  by something" without reading every row. */
export function DiffGraph({ changes }: { changes: readonly Change[] }) {
  const { nodes, edges } = useMemo(() => affectedGraph(changes), [changes]);
  const layout = useMemo(() => {
    const cols: GraphNode[][] = [[], [], []];
    for (const n of nodes) cols[n.column].push(n);
    const used = cols.map((c, i) => (c.length ? i : -1)).filter((i) => i >= 0);
    const x = new Map(used.map((c, i) => [c, PAD + i * (NODE_W + COL_GAP)]));
    const pos = new Map<string, { x: number; y: number }>();
    for (const [c, list] of cols.entries()) {
      list.forEach((n, i) => pos.set(n.key, { x: x.get(c)!, y: PAD + i * ROW }));
    }
    const rows = Math.max(...cols.map((c) => c.length), 1);
    return { pos, width: PAD * 2 + used.length * NODE_W + (used.length - 1) * COL_GAP, height: PAD * 2 + (rows - 1) * ROW + NODE_H };
  }, [nodes]);

  if (!edges.length) return null;
  return (
    <div className="dg">
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} style={{ maxWidth: "100%" }} role="img"
           aria-label={`${nodes.length} devices, ${edges.length} connections changed`}>
        {edges.map((e, i) => {
          const a = layout.pos.get(e.from)!, b = layout.pos.get(e.to)!;
          // Several edges between the same two devices (one broken, one made) fan out
          // rather than drawing over each other.
          const twins = edges.filter((x) => x.from === e.from && x.to === e.to);
          const fan = (twins.indexOf(e) - (twins.length - 1) / 2) * 14;
          const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2 + fan;
          // Same column (a device that both provides and consumes): loop out to the right.
          const same = a.x === b.x;
          const x2 = same ? b.x + NODE_W : b.x, y2 = b.y + NODE_H / 2 + fan;
          const bend = same ? 60 : (x2 - x1) / 2;
          const d = `M${x1},${y1} C${x1 + bend},${y1} ${same ? x2 + bend : x2 - bend},${y2} ${x2},${y2}`;
          const mx = same ? x1 + bend * 0.75 : (x1 + x2) / 2, my = (y1 + y2) / 2 + fan * 0.6;
          return (
            <g key={i} className={`dg-edge ${e.effect}${e.cascade ? " cascade" : ""}`}>
              <path d={d} markerEnd={`url(#dg-arrow-${e.effect})`} />
              <text x={mx} y={my - 5} textAnchor="middle">{e.label}</text>
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = layout.pos.get(n.key)!;
          return (
            <g key={n.key} className={`dg-node ${n.effect ?? ""}`} transform={`translate(${p.x},${p.y})`}>
              <title>{n.room ? `${n.name} — ${n.room}` : n.name}</title>
              <rect width={NODE_W} height={NODE_H} rx={7} />
              <text x={10} y={15} className="dg-name">{clip(n.name, 24)}</text>
              <text x={10} y={28} className="dg-room">{clip(n.room, 28)}</text>
            </g>
          );
        })}
        <defs>
          {(["added", "removed"] as const).map((k) => (
            <marker key={k} id={`dg-arrow-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" className={`dg-head ${k}`} />
            </marker>
          ))}
        </defs>
      </svg>
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
