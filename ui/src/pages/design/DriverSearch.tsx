/** Items › Search: one search across the controller's drivers, the library and Control4's
 *  online database, as a table, with the picked driver's details and "Add to room…" below. */

import { createColumnHelper } from "@tanstack/react-table";
import { BadgeCheck, CircleHelp, FileUp, Globe, HardDrive, Plus, Search, Server, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { DataTable } from "../../components/DataTable";
import { Tip } from "../../components/Dialogs";
import { Spinner } from "../../components/controls";
import { DriverIcon } from "../../components/icons";
import type { Shell } from "../../lib/shell";
import { cx, useLoad } from "../../lib/ui";
import type { Add } from "./ItemsPane";
import { best, categoryOf, declares, fromOnline, matchesText, merge, type DriverRow, type Local, type Where } from "./drivers";

/** Text, and optionally an SDDP type ("Find driver" on a discovered device). */
export interface Query {
  text: string;
  type: string | null;
}

const AVAIL: Record<Where | "unknown", [label: string, icon: LucideIcon, cls: string, tip: string]> = {
  controller: ["controller", Server, "on", "Installed on this controller"],
  library: ["library", HardDrive, "accent", "In openComposer's library on this computer: installed as part of the add"],
  online: ["online", Globe, "warn", "In Control4's driver database, not on this computer: adding downloads it (checked against the database's checksum) and installs it in the same approval"],
  unknown: ["no driver", CircleHelp, "", "No driver for this device was found here or online"],
};

/** Where a driver file can come from, as a badge. */
export function Avail({ where }: { where: Where | "unknown" }) {
  const [label, Icon, cls, tip] = AVAIL[where];
  return <Tip text={tip}><span className={cx("tag avail", cls)}><Icon size={11} strokeWidth={1.8} />{label}</span></Tip>;
}

const RANK: Record<Where, number> = { controller: 0, library: 1, online: 2 };
const col = createColumnHelper<DriverRow>();

export function DriverSearch({ shell, local, controllerError, query, onQuery, picked, onPick, room, add, focus, onImport }: {
  shell: Shell;
  local: Local;
  controllerError?: string;
  query: Query;
  onQuery: (q: Query) => void;
  picked: string | null;
  onPick: (filename: string | null) => void;
  room: { id: number; name: string } | null;
  add: Add;
  focus: number;
  onImport: (filename: string) => Promise<void>;
}) {
  const [text, setText] = useState(query.text);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focus) input.current?.focus(); }, [focus]);
  // Follow a query set from outside (Find driver), not our own trimmed echo of it.
  useEffect(() => setText((t) => (t.trim() === query.text ? t : query.text)), [query.text]);
  // Local lists filter as you type; the database is on the internet, so it waits for a pause.
  useEffect(() => {
    const t = setTimeout(() => { if (text.trim() !== query.text) onQuery({ ...query, text: text.trim() }); }, 400);
    return () => clearTimeout(t);
  }, [text, query, onQuery]);

  const online = useLoad(() => (
    query.type ? api.searchDrivers({ search_type: query.type, rows: 50 })
      : query.text.length >= 2 ? api.searchDrivers({ text: query.text, rows: 50 })
      : Promise.resolve(null)
  ), [query.text, query.type]);

  const all = useMemo(() => merge(local.controller ?? [], local.library, (online.data?.drivers ?? []).map(fromOnline)), [local, online.data]);
  const hits = useMemo(() => new Set((online.data?.drivers ?? []).map((d) => d.filename.toLowerCase())), [online.data]);
  const shown = useMemo(() => all.filter((r) =>
    (query.type ? declares(r, query.type) || hits.has(r.filename.toLowerCase()) : true)
    // The database's own matching is fuzzier than ours; keep what it found for the text.
    && ((!query.type && hits.has(r.filename.toLowerCase())) || matchesText(r, text))), [all, hits, query.type, text]);
  // Only a pick that is among the results: one made in My Drivers may not be.
  const sel = shown.find((r) => r.filename === picked) ?? null;
  const searching = !!query.type || query.text.length >= 2;
  const why = shell.writable ? undefined : `${shell.director?.name ?? "This Director"} is read-only`;

  const columns = useMemo(() => [
    col.accessor("name", {
      header: "Driver",
      cell: (c) => (
        <span className="row nowrap ellip">
          <DriverIcon driver={c.row.original.filename} proxy={c.row.original.primary_proxy ?? categoryOf(c.row.original).id} size={16} />
          <span className="ellip">{c.getValue()}</span>
          {c.row.original.certified && <Tip text="Certified by Control4"><BadgeCheck size={12} strokeWidth={1.8} className="ok" /></Tip>}
        </span>
      ),
    }),
    col.accessor("manufacturer", { header: "Maker", meta: { width: "24%", hideBelow: 340 }, cell: (c) => <span className="ellip">{c.getValue() || "—"}</span> }),
    col.accessor((r) => RANK[best(r)], { id: "where", header: "Source", meta: { width: 92 }, cell: (c) => <Avail where={best(c.row.original)} /> }),
  ], []);

  return (
    <>
      <div className="search-box">
        <Search size={13} strokeWidth={1.8} />
        {query.type && (
          <span className="chip cls type-chip" title="Drivers that declare this SDDP type">{query.type}
            <button className="chip-x" aria-label="Clear the type" onClick={() => onQuery({ ...query, type: null })}><X size={11} strokeWidth={1.8} /></button>
          </span>
        )}
        <input ref={input} placeholder={query.type ? "Narrow down…" : "Search every driver: “lg oled”, “denon”…"} value={text}
               onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onQuery({ ...query, text: text.trim() })} />
        {online.loading && searching && <Spinner />}
      </div>
      {(!searching || (local.controller == null && controllerError) || online.error) && (
        <div className="notes">
          {!searching && <p className="hint pad-t">Your drivers are listed; type to search Control4's online database too (~25,000 drivers).</p>}
          {local.controller == null && controllerError && <p className="hint pad-t warn">Couldn't list the controller's drivers: {controllerError}</p>}
          {online.error && <p className="hint pad-t err">Online search failed: {online.error}</p>}
        </div>
      )}
      <DataTable data={shown} columns={columns} rowId={(r) => r.filename} label="Drivers" sort={[{ id: "where", desc: false }]}
                 selected={picked} onSelect={(r) => onPick(r.filename)} onActivate={(r) => { if (!why) void add(r); }}
                 empty={searching && online.loading ? <span className="dim"><Spinner />Searching…</span>
                   : <p className="empty">{searching ? <>No drivers match{query.type ? <> <code>{query.type}</code></> : ` “${query.text}”`}.</> : "Nothing installed or in the library yet."}</p>} />
      {online.data && online.data.total > online.data.drivers.length && (
        <p className="hint pad-t dim small">Showing {online.data.drivers.length} of {online.data.total} online matches — narrow the search to see others.</p>
      )}
      {sel && <Detail d={sel} shell={shell} room={room} add={add} onImport={onImport} />}
    </>
  );
}

/** The picked driver: where it can come from, what it is, and adding it. */
export function Detail({ d, shell, room, add, onImport }: {
  d: DriverRow; shell: Shell; room: { id: number; name: string } | null; add: Add; onImport?: (filename: string) => Promise<void>;
}) {
  const why = shell.writable ? undefined : `${shell.director?.name ?? "This Director"} is read-only`;
  const onlineOnly = best(d) === "online";
  return (
    <div className="drv-detail">
      <div className="drv-detail-head">
        <DriverIcon driver={d.filename} proxy={d.primary_proxy ?? categoryOf(d).id} size={28} />
        <div className="drv-detail-title">
          <b>{d.name}</b>
          <span className="dim small">{[d.manufacturer, d.model].filter(Boolean).join(" · ") || "—"}</span>
        </div>
        <span className="chips spread">{d.where.map((w) => <Avail key={w} where={w} />)}</span>
      </div>
      <div className="drv-facts">
        <span className="k">File</span><code>{d.filename}</code>
        <span className="k">Version</span><span>{d.version ?? "—"}{d.library?.source === "composer" && <span className="dim"> · from Composer's driver folder</span>}</span>
        {d.control_method && <><span className="k">Control</span><span>{d.control_method}</span></>}
        {!!d.proxies.length && <><span className="k">Proxies</span><span>{[...new Set(d.proxies)].join(", ")}</span></>}
        {!!d.search_types.length && <><span className="k">SDDP</span><span className="mono">{d.search_types.join(", ")}</span></>}
      </div>
      {onlineOnly && <p className="dim small flush-p">Not on this computer yet: adding downloads it from Control4's database. If the database won't hand it over (some dealer-only drivers), import the file instead.</p>}
      <div className="row">
        <Tip text={why}>
          <span><button className="act small primary" disabled={!!why} onClick={() => void add(d)}>
            <Plus size={13} strokeWidth={1.8} />{room ? `Add to ${room.name}…` : "Add to room…"}
          </button></span>
        </Tip>
        {onlineOnly && onImport && (
          <button className="act small" onClick={() => void onImport(d.filename)}><FileUp size={13} strokeWidth={1.8} />Import file…</button>
        )}
      </div>
    </div>
  );
}
