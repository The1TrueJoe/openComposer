import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TreeNode } from "../../api";
import { DriverIcon, KindIcon } from "../../components/icons";
import { chain, filterTree, indexTree } from "../../lib/project";
import { cx, toggleIn } from "../../lib/ui";

type Row = { node: TreeNode; depth: number; open: boolean; hasKids: boolean };

/** Everything down to rooms opens by default; a device's proxies stay folded, because in a
 *  real house they double the length of the tree and are rarely what you're looking for. */
const openByDefault = (n: TreeNode) => n.kind !== "device" && n.kind !== "proxy";

/** Composer's system tree: site → building → floor → room → device → proxy, then agents. */
export function ProjectTree({ root, sel, onSelect, onMenu, onControl }: {
  root: TreeNode;
  sel: number | null;
  onSelect: (id: number) => void;
  onMenu: (e: React.MouseEvent, n: TreeNode) => void;
  /** Double-click (or Enter) on a device or proxy: its control panel. */
  onControl: (id: number) => void;
}) {
  const [filter, setFilter] = useState("");
  // Rows whose open state differs from the default; a set of exceptions survives a refetch.
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const { places, agents } = useMemo(() => {
    const visible = filterTree(root, filter) ?? { ...root, children: [] };
    return {
      places: { ...visible, children: visible.children.filter((c) => c.kind !== "agent") },
      agents: visible.children.filter((c) => c.kind === "agent"),
    };
  }, [root, filter]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (n: TreeNode, depth: number) => {
      const open = !!filter.trim() || openByDefault(n) !== flipped.has(n.id);
      out.push({ node: n, depth, open, hasKids: n.children.length > 0 });
      if (open) for (const c of n.children) walk(c, depth + 1);
    };
    walk(places, 0);
    for (const a of agents) walk(a, 0);
    return out;
  }, [places, agents, flipped, filter]);

  // A selection made from outside (an assistant's ui_show, a device just added) may be inside
  // folded rows, or not in the tree yet until it refetches: open its ancestors once it is
  // there, then bring it into view.
  const reveal = useRef<number | null>(null);
  const scroll = useRef(false);
  useEffect(() => { reveal.current = sel; }, [sel]);
  useEffect(() => {
    const id = reveal.current;
    if (id == null) return;
    const idx = indexTree(root);
    if (!idx.has(id)) return;
    reveal.current = null;
    const next = chain(idx, id).slice(0, -1).reduce((acc, a) => (openByDefault(a) !== acc.has(a.id) ? acc : toggleIn(acc, a.id)), flipped);
    if (next === flipped) {
      listRef.current?.querySelector(".tw-row.sel")?.scrollIntoView({ block: "nearest" });
    } else {
      scroll.current = true;
      setFlipped(next);
    }
    // `flipped` is read, not watched: folding a row by hand must not re-open it.
  }, [sel, root]);
  useEffect(() => {
    if (!scroll.current) return;
    scroll.current = false;
    listRef.current?.querySelector(".tw-row.sel")?.scrollIntoView({ block: "nearest" });
  }, [rows]);

  const onKey = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.node.id === sel);
    const r = rows[i];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) onSelect(next.node.id);
    } else if (r && e.key === "Enter" && (r.node.kind === "device" || r.node.kind === "proxy")) {
      e.preventDefault();
      onControl(r.node.id);
    } else if (r && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      if (r.hasKids && r.open !== (e.key === "ArrowRight")) setFlipped(toggleIn(flipped, r.node.id));
    }
  };

  const firstAgent = agents[0]?.id;
  return (
    <>
      <div className="search-box">
        <Search size={13} strokeWidth={1.8} />
        <input placeholder="Filter rooms, devices, drivers…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="panel-body tw" ref={listRef} tabIndex={0} onKeyDown={onKey} role="tree" aria-label="Project">
        {rows.map((r) => (
          <div key={r.node.id}>
            {r.node.id === firstAgent && <div className="group">Agents</div>}
            <div className={cx("tw-row", sel === r.node.id && "sel", r.node.kind === "proxy" && "proxy")}
                 style={{ paddingLeft: 6 + r.depth * 14 }} role="treeitem" aria-selected={sel === r.node.id}
                 aria-expanded={r.hasKids ? r.open : undefined}
                 onClick={() => onSelect(r.node.id)} onContextMenu={(e) => { onSelect(r.node.id); onMenu(e, r.node); }}
                 onDoubleClick={() => {
                   if (r.node.kind === "device" || r.node.kind === "proxy") onControl(r.node.id);
                   else if (r.hasKids) setFlipped(toggleIn(flipped, r.node.id));
                 }}>
              <span className={cx("tw-tw", r.hasKids && "hit")}
                    onClick={(e) => { e.stopPropagation(); if (r.hasKids) setFlipped(toggleIn(flipped, r.node.id)); }}>
                {r.hasKids && (r.open ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />)}
              </span>
              <span className="tw-ic">
                {r.node.kind === "device" || r.node.kind === "agent"
                  ? <DriverIcon driver={r.node.driver} kind={r.node.kind} size={15} />
                  : <KindIcon kind={r.node.kind} driver={r.node.driver} proxy={r.node.kind === "proxy" ? r.node.driver?.replace(/\.c4[iz]$/i, "") : null} />}
              </span>
              <span className="tw-label">{r.node.name}</span>
              {r.node.kind === "room" && <span className="tw-meta">{r.node.children.filter((c) => c.kind === "device").length || ""}</span>}
            </div>
          </div>
        ))}
        {rows.length <= 1 && filter && <p className="empty pad">Nothing matches “{filter}”.</p>}
      </div>
    </>
  );
}
