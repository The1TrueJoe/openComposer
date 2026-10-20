/** The inspector's Connections tab, shaped like Composer's Connections view: the selected
 *  item's connections (its own and its proxies') on top; below, for the connection picked
 *  there, every endpoint it could be joined to, filterable by room, class and text, to connect
 *  or disconnect. Each change is a proposal with its approval card. */

import { createColumnHelper } from "@tanstack/react-table";
import { ArrowDownToLine, ArrowUpFromLine, Link2, Search, Unlink, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api, type ConnectionDef, type ConnectionRow, type ItemDetail, type KindLabel, type Peer } from "../../api";
import { DataTable } from "../../components/DataTable";
import { Tip } from "../../components/Dialogs";
import { Select, Spinner } from "../../components/controls";
import { KindIcon } from "../../components/icons";
import { connectOp, disconnectOp, shared } from "../../lib/connections";
import type { Shell } from "../../lib/shell";
import { cx, useLoad } from "../../lib/ui";

interface Owner { id: number; name: string; kind: KindLabel; driver: string | null }
interface Conn { key: string; owner: Owner; def: ConnectionDef }

const ALL = "";
const connCol = createColumnHelper<Conn>();

export function Connections({ d, shell, onSelect }: { d: ItemDetail; shell: Shell; onSelect: (id: number) => void }) {
  const conns: Conn[] = useMemo(() => {
    const owners: (Owner & { connections: ConnectionDef[] })[] = [
      { id: d.id, name: d.name, kind: d.kind, driver: d.driver, connections: d.connections },
      ...d.children.filter((c) => c.connections.length),
    ];
    return owners.flatMap((o) => o.connections.map((def) => ({
      key: `${o.id}:${def.id}`, owner: { id: o.id, name: o.name, kind: o.kind, driver: o.driver }, def,
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
      id: "name", header: "Name", meta: { width: "32%" },
      cell: (x) => (
        <span className="conn-name">
          {x.row.original.def.role === "input" ? <ArrowDownToLine size={13} strokeWidth={1.8} className="dim" /> : <ArrowUpFromLine size={13} strokeWidth={1.8} className="dim" />}
          <span className="ellip" title={`${x.getValue()} · binding #${x.row.original.def.id}`}>{x.getValue()}</span>
        </span>
      ),
    }),
    ...(proxies ? [col.accessor((c) => c.owner.name, {
      id: "owner", header: "On", meta: { width: "18%", hideBelow: 540 },
      cell: (x) => <span className="row nowrap ellip"><KindIcon kind={x.row.original.owner.kind} driver={x.row.original.owner.driver} size={12} />{x.getValue()}</span>,
    })] : []),
    col.accessor((c) => c.def.classes.join(" "), {
      id: "type", header: "Type", meta: { width: "20%", hideBelow: 520 },
      cell: (x) => <Classes list={x.row.original.def.classes} />,
    }),
    col.accessor((c) => c.def.role, {
      id: "io", header: "Input/Output", meta: { width: 96, hideBelow: 600 },
      cell: (x) => <span className="dim">{x.getValue() === "input" ? "Input" : "Output"}</span>,
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
      <DataTable data={conns} columns={columns} rowId={(c) => c.key} label={`${d.name}'s connections`} className="conn-top"
                 selected={sel?.key ?? null} onSelect={(c) => setPicked(c.key)} autoFocus />
      {sel && <Endpoints key={sel.key} c={sel} room={d.room} shell={shell} onSelect={onSelect} why={why} />}
    </div>
  );
}

function Classes({ list }: { list: string[] }) {
  const more = list.length - 2;
  return (
    <span className="chips nowrap">
      {list.slice(0, 2).map((k) => <span key={k} className="chip cls">{k}</span>)}
      {more > 0 && <Tip text={list.slice(2).join(" · ")}><span className="dim small">+{more}</span></Tip>}
    </span>
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
          {x.row.original.row.connection.role === "input" ? <ArrowDownToLine size={12} strokeWidth={1.8} className="dim" /> : <ArrowUpFromLine size={12} strokeWidth={1.8} className="dim" />}
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
        </span>
        <Select value={roomF} onValueChange={setRoomF} label="Room" options={[{ value: ALL, label: "All rooms" }, ...rooms.map((r) => ({ value: r, label: r }))]} />
        <Select value={classF} onValueChange={setClassF} label="Class" options={[{ value: ALL, label: "All classes" }, ...classes.map((k) => ({ value: k, label: k }))]} />
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
                     empty={<p className="empty">{filtered ? "Nothing matches the filters." : `Nothing in the project can ${c.def.role === "input" ? "feed" : "take"} ${c.def.classes.join("/")}.`}</p>} />
        )}
    </div>
  );
}
