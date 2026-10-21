/** Items › My Drivers: the drivers at hand — installed on the controller (Control4's own
 *  controllers, keypads, dimmers and remotes among them) and in the library on this computer —
 *  filed by category like Composer's tree. Pick one to see it; double-click to add it. */

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "../../components/controls";
import { WithDetail } from "../../components/Panes";
import { DriverIcon } from "../../components/icons";
import type { Shell } from "../../lib/shell";
import { cx, toggleIn } from "../../lib/ui";
import { Avail, Detail } from "./DriverSearch";
import type { Add } from "./ItemsPane";
import { CATEGORIES, OTHER, best, categoryOf, matchesText, merge, type DriverRow, type Local } from "./drivers";

type Row =
  | { kind: "folder"; id: string; title: string; count: number; open: boolean }
  | { kind: "driver"; d: DriverRow };

const ROW_HEIGHT = 24;

const rank = (id: string) => {
  if (id === OTHER.id) return 1000;
  const i = CATEGORIES.findIndex((c) => c.id === id);
  return i < 0 ? 500 : i;
};

export function MyDrivers({ shell, local, controllerError, loading, picked, onPick, room, add }: {
  shell: Shell; local: Local; controllerError?: string; loading: boolean;
  picked: string | null; onPick: (filename: string | null) => void; room: { id: number; name: string } | null; add: Add;
}) {
  const [filter, setFilter] = useState("");
  // Folders whose open state differs from the default (open).
  const [shut, setShut] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const all = useMemo(() => merge(local.controller ?? [], local.library), [local]);

  const groups = useMemo(() => {
    const by = new Map<string, { title: string; rows: DriverRow[] }>();
    for (const d of all) {
      if (!matchesText(d, filter)) continue;
      const c = categoryOf(d);
      const g = by.get(c.id) ?? { title: c.title, rows: [] };
      g.rows.push(d);
      by.set(c.id, g);
    }
    return [...by.entries()]
      .map(([id, g]) => ({ id, ...g, rows: g.rows.sort((a, b) => a.name.localeCompare(b.name)) }))
      // Composer's order (controllers first), then the controller's own categories, then Other.
      .sort((a, b) => rank(a.id) - rank(b.id) || a.title.localeCompare(b.title));
  }, [all, filter]);

  const rows: Row[] = useMemo(() => groups.flatMap((g): Row[] => {
    const open = !!filter.trim() || !shut.has(g.id);
    return [{ kind: "folder", id: g.id, title: g.title, count: g.rows.length, open }, ...(open ? g.rows.map((d): Row => ({ kind: "driver", d })) : [])];
  }), [groups, shut, filter]);

  const v = useVirtualizer({ count: rows.length, getScrollElement: () => box.current, estimateSize: () => ROW_HEIGHT, overscan: 16 });
  const at = rows.findIndex((r) => r.kind === "driver" && r.d.filename === picked);
  // A file just imported is picked from outside: bring it into view.
  useEffect(() => { if (at >= 0) v.scrollToIndex(at, { align: "auto" }); }, [picked]);
  const sel = all.find((d) => d.filename === picked) ?? null;
  const why = shell.writable ? undefined : "read-only";

  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== box.current) return;
    const drivers = rows.map((r, i) => [r, i] as const).filter(([r]) => r.kind === "driver");
    const k = drivers.findIndex(([, i]) => i === at);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = drivers[Math.max(0, Math.min(drivers.length - 1, k + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next && next[0].kind === "driver") { onPick(next[0].d.filename); v.scrollToIndex(next[1], { align: "auto" }); }
    } else if (e.key === "Enter" && sel && !why) {
      void add(sel);
    }
  };

  return (
    <WithDetail id="my-drivers" detail={sel && <Detail d={sel} shell={shell} room={room} add={add} />}>
      <div className="search-box">
        <Search size={13} strokeWidth={1.8} />
        <input placeholder="Filter my drivers…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter my drivers" />
        {loading && <Spinner />}
      </div>
      {local.controller == null && controllerError && <p className="hint pad-t warn">Couldn't list the controller's drivers: {controllerError}. The library is below.</p>}
      <div ref={box} className="panel-body tw mydrv" tabIndex={0} onKeyDown={onKey} role="tree" aria-label="My drivers">
        {!rows.length && !loading && <p className="empty pad">{filter ? `No driver matches “${filter}”.` : "No drivers on the controller or in the library yet."}</p>}
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((it) => {
            const r = rows[it.index];
            const style: React.CSSProperties = { position: "absolute", top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${it.start}px)` };
            if (r.kind === "folder") {
              return (
                <div key={`f:${r.id}`} className="tw-row folder" style={style} role="treeitem" aria-expanded={r.open}
                     onClick={() => setShut(toggleIn(shut, r.id))}>
                  <span className="tw-tw hit">{r.open ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}</span>
                  <span className="tw-ic folder-ic">{r.open ? <FolderOpen size={14} strokeWidth={1.7} /> : <Folder size={14} strokeWidth={1.7} />}</span>
                  <span className="tw-label">{r.title}</span>
                  <span className="tw-meta">{r.count}</span>
                </div>
              );
            }
            const d = r.d;
            return (
              <div key={d.filename} className={cx("tw-row", d.filename === picked && "sel")} style={{ ...style, paddingLeft: 26 }} role="treeitem"
                   aria-selected={d.filename === picked} title={`${d.filename}${d.manufacturer ? ` · ${d.manufacturer}` : ""}`}
                   onClick={() => onPick(d.filename)} onDoubleClick={() => { if (!why) void add(d); }}>
                <DriverIcon driver={d.filename} proxy={d.primary_proxy ?? categoryOf(d).id} size={15} />
                <span className="tw-label">{d.name}</span>
                {d.manufacturer && <span className="tw-meta mfr">{d.manufacturer}</span>}
                {best(d) === "library" && <span className="tw-badge"><Avail where="library" /></span>}
              </div>
            );
          })}
        </div>
      </div>
    </WithDetail>
  );
}
