import { BadgeCheck, CircleHelp, FileUp, Globe, HardDrive, Plus, Search, Server, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { Tip } from "../../components/Dialogs";
import { Spinner } from "../../components/controls";
import type { Shell } from "../../lib/shell";
import { cx, useLoad } from "../../lib/ui";
import type { Add } from "./AddDevices";
import { best, declares, fromOnline, matchesText, merge, type DriverRow, type Local, type Where } from "./drivers";

/** Text, and optionally an SDDP type ("Find driver" on a discovered device). */
export interface Query {
  text: string;
  type: string | null;
}

const AVAIL: Record<Where | "unknown", [label: string, icon: LucideIcon, cls: string, tip: string]> = {
  controller: ["on controller", Server, "on", "Installed on this controller"],
  library: ["in library", HardDrive, "accent", "In openComposer's library on this computer: installed as part of the add"],
  online: ["online", Globe, "warn", "In Control4's driver database, not on this computer: adding downloads it (checked against the database's checksum) and installs it in the same approval"],
  unknown: ["no driver", CircleHelp, "", "No driver for this device was found here or online"],
};

/** Where a driver file can come from, as a badge. */
export function Avail({ where }: { where: Where | "unknown" }) {
  const [label, Icon, cls, tip] = AVAIL[where];
  return <Tip text={tip}><span className={cx("tag avail", cls)}><Icon size={11} strokeWidth={1.8} />{label}</span></Tip>;
}

const GROUPS: { where: Where; title: string }[] = [
  { where: "controller", title: "On the controller" },
  { where: "library", title: "In the library" },
  { where: "online", title: "Online" },
];

const byName = (a: DriverRow, b: DriverRow) => `${a.manufacturer} ${a.name}`.localeCompare(`${b.manufacturer} ${b.name}`);

/** One search across the controller's drivers, the library and Control4's online database. */
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
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) input.current?.focus(); }, [focus]);
  // A row picked from outside (a file just imported) may be far down the list.
  useEffect(() => { list.current?.querySelector(".drv.sel")?.scrollIntoView({ block: "nearest" }); }, [picked, local.library.length]);
  // Follow a query set from outside (Find driver, an import), not our own trimmed echo of it.
  useEffect(() => setText((t) => (t.trim() === query.text ? t : query.text)), [query.text]);
  // Local lists filter as you type; the database is on the internet, so it waits for a pause.
  useEffect(() => {
    const t = setTimeout(() => { if (text.trim() !== query.text) onQuery({ ...query, text: text.trim() }); }, 400);
    return () => clearTimeout(t);
  }, [text, query, onQuery]);

  const online = useLoad(() => (
    query.type ? api.searchDrivers({ search_type: query.type, rows: 40 })
      : query.text.length >= 2 ? api.searchDrivers({ text: query.text, rows: 40 })
      : Promise.resolve(null)
  ), [query.text, query.type]);

  const all = useMemo(() => merge(local.controller ?? [], local.library, (online.data?.drivers ?? []).map(fromOnline)), [local, online.data]);
  const hits = useMemo(() => new Set((online.data?.drivers ?? []).map((d) => d.filename.toLowerCase())), [online.data]);
  const shown = useMemo(() => all.filter((r) =>
    (query.type ? declares(r, query.type) || hits.has(r.filename.toLowerCase()) : true)
    // The database's own matching is fuzzier than ours; keep what it found for the text.
    && ((!query.type && hits.has(r.filename.toLowerCase())) || matchesText(r, text))), [all, hits, query.type, text]);
  const sel = all.find((r) => r.filename === picked) ?? null;
  const searching = !!query.type || query.text.length >= 2;

  return (
    <>
      <div className="search-box">
        <Search size={13} strokeWidth={1.8} />
        {query.type && (
          <span className="chip cls type-chip" title="Drivers that declare this SDDP type">{query.type}
            <button className="chip-x" aria-label="Clear the type" onClick={() => onQuery({ ...query, type: null })}><X size={11} strokeWidth={1.8} /></button>
          </span>
        )}
        <input ref={input} placeholder={query.type ? "Narrow down…" : "Search drivers: “lg oled”, “denon”…"} value={text}
               onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onQuery({ ...query, text: text.trim() })} />
        {online.loading && searching && <Spinner />}
      </div>
      <div className="panel-body" ref={list}>
        {!searching && <p className="hint pad-t">What's on the controller and in the library is listed below. Type to search Control4's online database too (~25,000 drivers).</p>}
        {local.controller == null && controllerError && <p className="hint pad-t warn">Couldn't list the controller's drivers: {controllerError}</p>}
        {online.error && <p className="hint pad-t err">Online search failed: {online.error}</p>}
        {GROUPS.map((g) => {
          const rows = shown.filter((r) => best(r) === g.where).sort(byName);
          if (!rows.length) return null;
          const total = g.where === "online" && online.data && online.data.total > online.data.drivers.length ? ` of ${online.data.total}` : "";
          return (
            <div key={g.where}>
              <div className="group">{g.title} <span className="n">{rows.length}{total}</span></div>
              {rows.map((d) => (
                <button key={d.filename} className={cx("drv", picked === d.filename && "sel")} onClick={() => onPick(d.filename)}
                        onDoubleClick={() => shell.writable && void add(d)}>
                  <span className="drv-top">
                    <b>{d.name}</b>
                    {d.certified && <Tip text="Certified by Control4"><BadgeCheck size={13} strokeWidth={1.8} className="ok" /></Tip>}
                    {d.control_method && <span className="spread tag">{d.control_method}</span>}
                  </span>
                  <span className="drv-sub">{[d.manufacturer, d.model].filter(Boolean).join(" · ") || "—"}</span>
                  <span className="drv-file mono">{d.filename}{d.version && <span> · v{d.version}</span>}</span>
                </button>
              ))}
            </div>
          );
        })}
        {searching && online.data && !shown.length && <p className="empty pad">No drivers match{query.type ? <> <code>{query.type}</code></> : ` “${query.text}”`}.</p>}
        {!searching && !shown.length && !local.controller && !local.library.length && <p className="empty pad">Nothing installed or in the library to show yet.</p>}
      </div>
      {sel && <Detail d={sel} shell={shell} room={room} add={add} onImport={onImport} />}
    </>
  );
}

function Detail({ d, shell, room, add, onImport }: {
  d: DriverRow; shell: Shell; room: { id: number; name: string } | null; add: Add; onImport: (filename: string) => Promise<void>;
}) {
  const why = shell.writable ? undefined : `${shell.director?.name ?? "This Director"} is read-only`;
  const onlineOnly = best(d) === "online";
  return (
    <div className="drv-detail">
      <div className="chips">
        {d.where.map((w) => <Avail key={w} where={w} />)}
        {d.library?.source === "composer" && <span className="dim small">from Composer's driver folder</span>}
      </div>
      <div className="drv-facts">
        <span className="k">File</span><code>{d.filename}</code>
        <span className="k">By</span><span>{d.manufacturer || "—"}{d.version && <span className="dim"> · v{d.version}</span>}</span>
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
        {onlineOnly && (
          <button className="act small" onClick={() => void onImport(d.filename)}><FileUp size={13} strokeWidth={1.8} />Import file…</button>
        )}
      </div>
    </div>
  );
}
