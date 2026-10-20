import { BadgeCheck, CircleCheck, CircleDashed, FileUp, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type DriverDoc, type DriverStatus } from "../../api";
import { Tip } from "../../components/Dialogs";
import { Spinner } from "../../components/controls";
import { cx, useLoad } from "../../lib/ui";

/** Control4's online driver database, and the way a driver gets into a room. */
/** `installed` is null when the controller couldn't be asked (web API off or unreachable). */
export type AddDriver = (driver: DriverDoc, room: number | null, installed: boolean | null) => void;

export function DriverCatalog({ room, writable, rev, onAdd, onInstall, focus }: {
  /** The room the selection is in: "Add" goes there without asking. */
  room: { id: number; name: string } | null;
  writable: boolean;
  /** The project revision: an install or a change re-asks whether the file is there. */
  rev: number;
  onAdd: AddDriver;
  onInstall: (driver: DriverDoc) => void;
  /** Changes when something outside ("Add device" on a room) wants the search field. */
  focus: number;
}) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (focus) input.current?.focus(); }, [focus]);
  // Typing settles before asking: the database is on the internet, not on the LAN.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 400);
    return () => clearTimeout(t);
  }, [text]);

  const res = useLoad(() => (q.length >= 2 ? api.searchDrivers({ text: q, rows: 40 }) : Promise.resolve(null)), [q]);
  const drivers = res.data?.drivers ?? [];
  const sel = drivers.find((d) => d.filename === picked) ?? null;

  return (
    <>
      <div className="search-box">
        <Search size={13} strokeWidth={1.8} />
        <input ref={input} placeholder="Search drivers: “lg oled”, “denon”…" value={text} onChange={(e) => setText(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && setQ(text.trim())} />
        {res.loading && q.length >= 2 && <Spinner />}
      </div>
      <div className="panel-body">
        {q.length < 2 && <p className="hint pad-t">Search Control4's online database (~25,000 drivers) by manufacturer, model or name. The driver file must already be on the controller to add it.</p>}
        {res.error && <p className="err pad">{res.error}</p>}
        {res.data && !drivers.length && <p className="empty pad">No drivers match “{q}”.</p>}
        {res.data && drivers.length > 0 && <div className="group">{res.data.total} found{res.data.total > drivers.length ? `, first ${drivers.length}` : ""}</div>}
        {drivers.map((d) => (
          <button key={d.filename} className={cx("drv", picked === d.filename && "sel")} onClick={() => setPicked(d.filename)}
                  onDoubleClick={() => writable && onAdd(d, room?.id ?? null, null)}>
            <span className="drv-top">
              <b>{d.name}</b>
              {d.certified && <Tip text="Certified by Control4"><BadgeCheck size={13} strokeWidth={1.8} className="ok" /></Tip>}
              <span className="spread tag">{d.control_method || "—"}</span>
            </span>
            <span className="drv-sub">{d.manufacturer} · {d.model}</span>
            <span className="drv-file mono">{d.filename}</span>
          </button>
        ))}
      </div>
      {sel && <DriverDetail d={sel} room={room} writable={writable} rev={rev} onAdd={onAdd} onInstall={onInstall} />}
    </>
  );
}

function DriverDetail({ d, room, writable, rev, onAdd, onInstall }: {
  d: DriverDoc; room: { id: number; name: string } | null; writable: boolean; rev: number; onAdd: AddDriver; onInstall: (d: DriverDoc) => void;
}) {
  const why = writable ? undefined : "This Director is read-only";
  const status = useLoad(() => api.driverStatus(d.filename), [d.filename, rev]);
  const installed = status.data?.filename === d.filename ? status.data.installed : null;
  return (
    <div className="drv-detail">
      <OnController status={status.data?.filename === d.filename ? status.data : undefined} error={status.error} loading={status.loading} />
      <div className="drv-facts">
        <span className="k">File</span><code>{d.filename}</code>
        <span className="k">By</span><span>{d.creator || d.manufacturer}{d.version != null && <span className="dim"> · v{d.version}</span>}{d.date_modified && <span className="dim"> · {d.date_modified.slice(0, 10)}</span>}</span>
        {!!d.proxies.length && <><span className="k">Proxies</span><span>{[...new Set(d.proxies)].join(", ")}</span></>}
        {!!d.search_types.length && <><span className="k">SDDP</span><span className="mono">{d.search_types.join(", ")}</span></>}
      </div>
      {!!d.connection_classes.length && (
        <div className="chips">{[...new Set(d.connection_classes)].map((c) => <span key={c} className="chip cls">{c}</span>)}</div>
      )}
      {!!d.connection_names.length && <p className="dim small">{d.connection_names.join(" · ")}</p>}
      <div className="row">
        {room && (
          <Tip text={why}><span><button className="act primary small" disabled={!writable} onClick={() => onAdd(d, room.id, installed)}>
            <Plus size={13} strokeWidth={1.8} />Add to {room.name}
          </button></span></Tip>
        )}
        <Tip text={why}><span><button className="act small" disabled={!writable} onClick={() => onAdd(d, null, installed)}>Add to room…</button></span></Tip>
        {installed === false && (
          <Tip text={why ?? "Put the driver file on the controller first"}>
            <span><button className="act small" disabled={!writable} onClick={() => onInstall(d)}><FileUp size={13} strokeWidth={1.8} />Install…</button></span>
          </Tip>
        )}
      </div>
    </div>
  );
}

/** Whether the driver file is already on the controller (asked through its web API). */
function OnController({ status, error, loading }: { status?: DriverStatus; error?: string; loading: boolean }) {
  if (loading && !status) return <span className="drv-status dim"><Spinner />Checking the controller…</span>;
  if (!status) return <span className="drv-status dim" title={error}>Can't tell whether it's on the controller{error ? ` — ${error}` : ""}</span>;
  if (!status.installed) return <span className="drv-status warn"><CircleDashed size={13} strokeWidth={1.8} />Not on this controller — install it before adding</span>;
  const version = status.info?.version ?? status.info?.Version;
  return <span className="drv-status ok"><CircleCheck size={13} strokeWidth={1.8} />On the controller{version != null && <span className="dim"> · version {String(version)}</span>}</span>;
}
