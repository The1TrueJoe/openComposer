/** The inspector's Connections tab, shaped like Composer's Connections view: the selected
 *  item's connections (its own and its proxies') on top, grouped into Inputs and Outputs and under
 *  each by kind (Video, Audio, Control…); below, past a grip, for the connection picked there,
 *  every endpoint it could be joined to, filterable by room, class and text, to connect or
 *  disconnect. Each change is a proposal with its approval card. */

import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpFromLine, ChevronDown, ChevronRight, Link2, Search, Unlink, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, type ConnectionDef, type ConnectionRow, type ItemDetail, type KindLabel, type Peer } from "../../api";
import { DataTable } from "../../components/DataTable";
import { Tip } from "../../components/Dialogs";
import { BottomPane, Grip, MainPane, Panes } from "../../components/Panes";
import { Select, Spinner } from "../../components/controls";
import { ConnChip, ConnIcon, KindIcon } from "../../components/icons";
import { classLook, CONN_KINDS, connectOp, disconnectOp, kindOf, shared, type ConnKind } from "../../lib/connections";
import type { Shell } from "../../lib/shell";
import { cx, useLoad } from "../../lib/ui";

interface Owner { id: number; name: string; kind: KindLabel; driver: string | null }
interface Conn { key: string; owner: Owner; def: ConnectionDef; kind: ConnKind }

const ALL = "";
const connCol = createColumnHelper<Conn>();

export function Connections({ d, shell, onSelect }: { d: ItemDetail; shell: Shell; onSelect: (id: number) => void }) {
  const conns: Conn[] = useMemo(() => {
    const owners: (Owner & { connections: ConnectionDef[] })[] = [
      { id: d.id, name: d.name, kind: d.kind, driver: d.driver, connections: d.connections },
      ...d.children.filter((c) => c.connections.length),
    ];
    return owners.flatMap((o) => o.connections.map((def) => ({
      key: `${o.id}:${def.id}`, owner: { id: o.id, name: o.name, kind: o.kind, driver: o.driver }, def, kind: kindOf(def),
    })));
  }, [d]);
  const [picked, setPicked] = useState<string | null>(null);
  const sel = conns.find((c) => c.key === picked) ?? conns[0] ?? null;
  const proxies = new Set(conns.map((c) => c.owner.id)).size > 1;
  const why = shell.writable ? undefined : `${shell.director?.name ?? "This Director"} is read-only`;

  const disconnect = (c: Conn, p: Peer) => shell.propose([disconnectOp(c.owner.id, c.def.id, c.def.role, p)]);

  const col = connCol;
  const columns = useMemo(() => [
    col.accessor((c) => c.def.name, {
      id: "name", header: "Name", meta: { width: "30%" },
      cell: (x) => (
        <span className="conn-name">
          <ConnIcon cls={x.row.original.def.classes[0] ?? ""} size={14} />
          <span className="ellip" title={`${x.getValue()} · binding #${x.row.original.def.id}`}>{x.getValue()}</span>
        </span>
      ),
    }),
    ...(proxies ? [col.accessor((c) => c.owner.name, {
      id: "owner", header: "On", meta: { width: "18%", hideBelow: 540 },
      cell: (x) => <span className="row nowrap ellip"><KindIcon kind={x.row.original.owner.kind} driver={x.row.original.owner.driver} size={12} />{x.getValue()}</span>,
    })] : []),
    col.accessor((c) => c.def.classes.map((k) => classLook(k).label).join(" "), {
      id: "type", header: "Type", meta: { width: "24%", hideBelow: 520 },
      cell: (x) => <Classes list={x.row.original.def.classes} />,
    }),
    col.accessor((c) => c.def.connected_to.map((p) => p.device.name).join(" "), {
      id: "to", header: "Connected to",
      cell: (x) => {
        const c = x.row.original;
        if (!c.def.connected_to.length) return <span className="dim">—</span>;
        return (
          <span className="chips">
            {c.def.connected_to.map((p, i) => (
              <span key={i} className="chip peer">
                {p.classes[0] && <ConnIcon cls={p.classes[0]} size={12} />}
                <button className="link" onClick={(e) => { e.stopPropagation(); onSelect(p.device.id); }}>{p.device.name} › {p.connection ?? `#${p.binding}`}</button>
                {shell.writable && (
                  <Tip text="Disconnect">
                    <button className="chip-x" aria-label="Disconnect" onClick={(e) => { e.stopPropagation(); void disconnect(c, p); }}><Unlink size={11} strokeWidth={1.8} /></button>
                  </Tip>
                )}
              </span>
            ))}
          </span>
        );
      },
    }),
  ], [proxies, shell, onSelect]);

  if (!conns.length) return <p className="empty pad">{d.name} has no connections.</p>;

  return (
    <div className="conn-split">
      <Panes id="connections" orientation="vertical">
        <MainPane id="mine" minSize={90}>
          <GroupedTable data={conns} columns={columns} label={`${d.name}'s connections`} selected={sel?.key ?? null} onSelect={(c) => setPicked(c.key)} />
        </MainPane>
        <Grip />
        <BottomPane id="ends" defaultSize="55%" minSize={130} maxSize="85%">
          {sel && <Endpoints key={sel.key} c={sel} room={d.room} shell={shell} onSelect={onSelect} why={why} />}
        </BottomPane>
      </Panes>
    </div>
  );
}

function Classes({ list }: { list: string[] }) {
  const more = list.length - 2;
  return (
    <span className="chips nowrap">
      {list.slice(0, 2).map((k) => <ConnChip key={k} cls={k} />)}
      {more > 0 && <Tip text={list.slice(2).map((k) => classLook(k).label).join(" · ")}><span className="dim small">+{more}</span></Tip>}
    </span>
  );
}

// ---- the grouped table -----------------------------------------------------------------------

const ROLES = [
  { id: "input", label: "Inputs", Icon: ArrowDownToLine },
  { id: "output", label: "Outputs", Icon: ArrowUpFromLine },
] as const;

// Which groups are folded is a per-viewer convenience: remembered when storage works, never needed.
const FOLDED = "oc-connections-folded";
const readFolded = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(FOLDED) ?? "[]") as string[]); } catch { return new Set(); } };
const saveFolded = (s: Set<string>) => { try { localStorage.setItem(FOLDED, JSON.stringify([...s])); } catch { /* not remembered */ } };

/** DataTable's look and keys with two levels of group rows: Inputs / Outputs, then the kind. Sorting
 *  by a header sorts within each group. Not a general grouping table — DataTable stays flat. */
function GroupedTable({ data, columns, label, selected, onSelect }: {
  data: Conn[];
  // Columns hold differently typed values; `unknown` would not accept them.
  columns: ColumnDef<Conn, any>[];
  label: string;
  selected: string | null;
  onSelect: (c: Conn) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [folded, setFolded] = useState<Set<string>>(readFolded);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { box.current?.focus({ preventScroll: true }); }, []);
  const columnVisibility = Object.fromEntries(columns.flatMap((c) =>
    c.id && c.meta?.hideBelow && width > 0 && width < c.meta.hideBelow ? [[c.id, false]] : []));
  const table = useReactTable({
    data, columns, state: { sorting, columnVisibility }, onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getRowId: (r) => r.key,
  });
  const rows = table.getRowModel().rows;
  const leaves = table.getVisibleLeafColumns();

  const groups = ROLES.map((role) => {
    const mine = rows.filter((r) => r.original.def.role === role.id);
    const kinds = CONN_KINDS.map((k) => ({ ...k, key: `${role.id}:${k.id}`, rows: mine.filter((r) => r.original.kind === k.id) })).filter((k) => k.rows.length);
    return { ...role, key: role.id as string, count: mine.length, kinds };
  }).filter((g) => g.count);
  // The rows the keyboard walks: those on screen, in screen order.
  const visible = groups.flatMap((g) => folded.has(g.key) ? [] : g.kinds.flatMap((k) => folded.has(k.key) ? [] : k.rows));

  const toggle = (key: string) => setFolded((f) => {
    const next = new Set(f);
    if (!next.delete(key)) next.add(key);
    saveFolded(next);
    return next;
  });

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select, button") && e.target !== box.current) return;
    if (!visible.length) return;
    const at = visible.findIndex((r) => r.id === selected);
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(visible.length - 1, at + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, at < 0 ? 0 : at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = visible.length - 1;
    else return;
    e.preventDefault();
    onSelect(visible[next].original);
    box.current?.querySelector<HTMLElement>(`tr[data-key="${visible[next].id}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const head = (key: string, sub: boolean, open: boolean, body: React.ReactNode, count: number) => (
    <tr className={cx("cg", sub && "sub")} onClick={() => toggle(key)}>
      <td colSpan={leaves.length}>
        <button className="cg-in" aria-expanded={open} tabIndex={-1} onClick={(e) => { e.stopPropagation(); toggle(key); }}>
          {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
          {body}
          <span className="cg-n">{count}</span>
        </button>
      </td>
    </tr>
  );

  return (
    <div ref={box} className="dt dt-scroll grouped conn-top" tabIndex={0} onKeyDown={onKey} role="grid" aria-label={label} aria-rowcount={rows.length}>
      <table>
        <colgroup>{leaves.map((c) => <col key={c.id} style={{ width: c.columnDef.meta?.width }} />)}</colgroup>
        <thead>
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id}>
              {g.headers.map((h) => {
                const dir = h.column.getIsSorted();
                return (
                  <th key={h.id} aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : undefined}>
                    <button className={cx("dt-sort", dir && "on")} onClick={h.column.getToggleSortingHandler()} tabIndex={-1}>
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {dir === "asc" ? <ArrowUp size={11} strokeWidth={2} /> : dir === "desc" ? <ArrowDown size={11} strokeWidth={2} /> : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {groups.map((g) => {
            const open = !folded.has(g.key);
            return (
              <Fragment key={g.key}>
                {head(g.key, false, open, <><g.Icon size={12} strokeWidth={2} />{g.label}</>, g.count)}
                {open && g.kinds.map((k) => {
                  const kOpen = !folded.has(k.key);
                  return (
                    <Fragment key={k.key}>
                      {head(k.key, true, kOpen, <KindLabelOf kind={k.id} label={k.label} rows={k.rows.map((r) => r.original)} />, k.rows.length)}
                      {kOpen && k.rows.map((r) => (
                        <tr key={r.id} data-key={r.id} aria-selected={r.id === selected} className={cx(r.id === selected && "sel", "pick")}
                            onClick={() => onSelect(r.original)}>
                          {r.getVisibleCells().map((c) => <td key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A sub-group's name, with the connector icons of the classes in it (at most four). */
function KindLabelOf({ label, rows }: { kind: ConnKind; label: string; rows: Conn[] }) {
  const classes = [...new Set(rows.flatMap((r) => r.def.classes.slice(0, 1)))].slice(0, 4);
  return (
    <>
      {label}
      <span className="cg-icons">{classes.map((k) => <ConnIcon key={k} cls={k} size={13} />)}</span>
    </>
  );
}

// ---- the other ends --------------------------------------------------------------------------

const endCol = createColumnHelper<End>();

interface End {
  key: string;
  row: ConnectionRow;
  /** Joined to the selected connection already. */
  here: Peer | null;
  /** An input fed by something else (it takes one provider). */
  takenBy: string | null;
  status: 0 | 1 | 2;
}

function Endpoints({ c, room, shell, onSelect, why }: { c: Conn; room: string | null; shell: Shell; onSelect: (id: number) => void; why?: string }) {
  const all = useLoad(() => api.connections(), [shell.rev]);
  const [roomF, setRoomF] = useState(ALL);
  const [classF, setClassF] = useState(ALL);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const from: ConnectionRow = { device: { id: c.owner.id, name: c.owner.name, room }, connection: c.def };
  // An input takes a single provider: while it has one, pick it only to disconnect.
  const full = c.def.role === "input" && c.def.connected_to.length > 0;

  const ends: End[] = useMemo(() => (all.data?.connections ?? [])
    .filter((r) => r.device.id !== c.owner.id && r.connection.role !== c.def.role && shared(r.connection.classes, c.def.classes).length > 0)
    .map((r) => {
      const here = c.def.connected_to.find((p) => p.device.id === r.device.id && p.binding === r.connection.id) ?? null;
      const takenBy = !here && r.connection.role === "input" && r.connection.connected_to.length
        ? r.connection.connected_to.map((p) => p.device.name).join(", ") : null;
      return { key: `${r.device.id}:${r.connection.id}`, row: r, here, takenBy, status: here ? 0 : takenBy ? 2 : 1 };
    }), [all.data, c]);

  const rooms = useMemo(() => [...new Set(ends.map((e) => e.row.device.room ?? ""))].filter(Boolean).sort(), [ends]);
  const classes = useMemo(() => [...new Set(ends.flatMap((e) => shared(e.row.connection.classes, c.def.classes)))].sort(), [ends, c]);
  const q = text.trim().toLowerCase();
  const shown = ends.filter((e) =>
    (roomF === ALL || e.row.device.room === roomF)
    && (classF === ALL || e.row.connection.classes.includes(classF))
    && (!q || `${e.row.device.name} ${e.row.connection.name} ${e.row.device.room ?? ""}`.toLowerCase().includes(q)));
  const filtered = roomF !== ALL || classF !== ALL || !!q;

  const act = (e: End) => {
    if (e.here) return void shell.propose([disconnectOp(c.owner.id, c.def.id, c.def.role, e.here)]);
    if (full || e.takenBy || !shell.writable) return;
    void shell.propose([connectOp(from, e.row)]);
  };

  const col = endCol;
  const columns = useMemo(() => [
    col.accessor((e) => e.row.device.name, {
      id: "device", header: "Device", meta: { width: "26%" },
      cell: (x) => (
        <span className="row nowrap ellip">
          <span className="tw-ic"><KindIcon kind="device" driver={x.getValue()} size={13} /></span>
          <button className="link ellip" onClick={(ev) => { ev.stopPropagation(); onSelect(x.row.original.row.device.id); }}>{x.getValue()}</button>
        </span>
      ),
    }),
    col.accessor((e) => e.row.connection.name, {
      id: "conn", header: "Name", meta: { width: "22%" },
      cell: (x) => (
        <span className="conn-name">
          <ConnIcon cls={shared(x.row.original.row.connection.classes, c.def.classes)[0] ?? x.row.original.row.connection.classes[0] ?? ""} size={13} />
          <span className="ellip">{x.getValue()}</span>
        </span>
      ),
    }),
    col.accessor((e) => e.row.device.room ?? "", { id: "room", header: "Location", meta: { width: "16%", hideBelow: 560 }, cell: (x) => x.getValue() || <span className="dim">—</span> }),
    col.accessor((e) => e.row.connection.classes.join(" "), { id: "cls", header: "Type", meta: { width: "16%", hideBelow: 660 }, cell: (x) => <Classes list={x.row.original.row.connection.classes} /> }),
    col.accessor("status", {
      header: "Status",
      cell: (x) => {
        const e = x.row.original;
        if (e.here) return <span className="tag on">connected</span>;
        if (e.takenBy) return <Tip text={`Fed by ${e.takenBy}; an input takes one source`}><span className="dim small ellip">in use · {e.takenBy}</span></Tip>;
        return <span className="dim small">{e.row.connection.connected_to.length ? `feeds ${e.row.connection.connected_to.length}` : "free"}</span>;
      },
    }),
    col.display({
      id: "act", meta: { width: 112, align: "right" },
      cell: (x) => {
        const e = x.row.original;
        if (e.here) {
          return (
            <Tip text={why}><span><button className="act small danger" disabled={!!why} onClick={() => act(e)}><Unlink size={12} strokeWidth={1.8} />Disconnect</button></span></Tip>
          );
        }
        const block = why ?? (full ? `${c.def.name} already takes ${c.def.connected_to.map((p) => p.device.name).join(", ")} — disconnect it first` : e.takenBy ? `${e.row.connection.name} is already fed by ${e.takenBy}` : undefined);
        return <Tip text={block}><span><button className="act small" disabled={!!block} onClick={() => act(e)}><Link2 size={12} strokeWidth={1.8} />Connect</button></span></Tip>;
      },
    }),
  ], [c, full, why, shell, onSelect]);

  return (
    <div className="conn-ends">
      <div className="filters conn-filters">
        <span className="conn-ends-title">
          {c.def.role === "input" ? "Sources for" : "Destinations for"} <b>{c.owner.name} › {c.def.name}</b>
          <span className="chips conn-ends-cls">{c.def.classes.map((k) => <ConnChip key={k} cls={k} />)}</span>
        </span>
        <Select value={roomF} onValueChange={setRoomF} label="Room" options={[{ value: ALL, label: "All rooms" }, ...rooms.map((r) => ({ value: r, label: r }))]} />
        <Select value={classF} onValueChange={setClassF} label="Class" options={[{ value: ALL, label: "All types" }, ...classes.map((k) => ({ value: k, label: `${classLook(k).label} · ${k}` }))]} />
        <span className="search-box inline"><Search size={12} strokeWidth={1.8} />
          <input placeholder="Filter…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter endpoints" />
          {text && <button className="chip-x" aria-label="Clear" onClick={() => setText("")}><X size={11} strokeWidth={1.8} /></button>}
        </span>
        {filtered && <button className="act small quiet" onClick={() => { setRoomF(ALL); setClassF(ALL); setText(""); }}>Clear filters</button>}
      </div>
      {!all.data && !all.error
        ? <div className="loading"><Spinner size="lg" /><span>Reading the project's connections…</span></div>
        : all.error ? <p className="err pad">{all.error}</p>
        : (
          <DataTable data={shown} columns={columns} rowId={(e) => e.key} label="Compatible endpoints" sort={[{ id: "status", desc: false }]}
                     selected={picked} onSelect={(e) => setPicked(e.key)} onActivate={act} rowClass={(e) => cx(e.here && "linked", e.takenBy && "dimmed")}
                     empty={<p className="empty">{filtered ? "Nothing matches the filters." : `Nothing in the project can ${c.def.role === "input" ? "feed" : "take"} ${c.def.classes.map((k) => classLook(k).label).join("/")}.`}</p>} />
        )}
    </div>
  );
}
