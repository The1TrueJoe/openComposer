/** Items › Discovered: devices on the network that no project device is identified as —
 *  Director's own list and what this computer hears over SDDP — as a compact table like
 *  Composer's, with where a driver for each can come from and an Add that identifies it. */

import { createColumnHelper } from "@tanstack/react-table";
import { PackageSearch, Plus, Radar } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errText, type Announcement, type DriverDoc } from "../../api";
import { DataTable } from "../../components/DataTable";
import { Tip } from "../../components/Dialogs";
import { Spinner } from "../../components/controls";
import { DriverIcon } from "../../components/icons";
import { Failure } from "../../components/shell";
import { unidentified, type Unidentified } from "../../lib/network";
import type { Shell } from "../../lib/shell";
import { plural, useLoad } from "../../lib/ui";
import { Avail } from "./DriverSearch";
import type { Add, AddTarget } from "./ItemsPane";
import { localFor, whereLocal, type Local, type Where } from "./drivers";

// The last scan, kept while the app runs: listening takes seconds, and coming back to the
// pane shouldn't mean waiting again. Rescan replaces it.
let lastScan: Announcement[] | null = null;
// What the online database said per SDDP type, for the session.
const onlineByType = new Map<string, DriverDoc[] | "error">();

interface Row {
  d: Unidentified;
  /** What the device is, from its SDDP type: "television", "av_gen"… */
  type: string;
  file: string | null;
  where: Where | "unknown" | null;
  target: AddTarget | null;
}

const col = createColumnHelper<Row>();

/** "c4:television:sony" → "television"; "apple-tv" stays. */
const typeWord = (t: string) => (t.startsWith("c4:") ? t.split(":")[1] ?? t : t).replace(/_gen$/, "").replace(/_/g, " ");

export function Discovered({ shell, local, add, onFind }: {
  shell: Shell; local: Local; add: Add; onFind: (searchType: string) => void;
}) {
  const net = useLoad(() => api.network(), [shell.rev, shell.director?.id]);
  const [scan, setScan] = useState<Announcement[] | null>(lastScan);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [online, setOnline] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);

  const rescan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      lastScan = (await api.sddp(4, "*")).devices;
      setScan(lastScan);
    } catch (e) {
      setScanError(errText(e));
    } finally {
      setScanning(false);
    }
  }, []);
  useEffect(() => { if (!lastScan) void rescan(); }, [rescan]);

  const found = useMemo(() => unidentified(net.data, scan ?? undefined), [net.data, scan]);

  // Devices with no driver here: does the database know one? Asked once per type per session.
  useEffect(() => {
    const types = [...new Set(found.filter((d) => !whereLocal(local, d.driver || "") && !localFor(local, d.device_type)).map((d) => d.device_type))]
      .filter((t) => !onlineByType.has(t));
    if (!types.length) return;
    let gone = false;
    void Promise.all(types.map(async (t) => {
      try {
        onlineByType.set(t, (await api.searchDrivers({ search_type: t, rows: 10 })).drivers);
      } catch {
        onlineByType.set(t, "error");
      }
    })).then(() => { if (!gone) setOnline((n) => n + 1); });
    return () => { gone = true; };
  }, [found, local]);

  const rows: Row[] = useMemo(() => found.map((d) => {
    // The driver: the one the device names, or failing that one here that declares its type.
    const named = d.driver || null;
    const match = named ? null : localFor(local, d.device_type);
    const file = named ?? match?.filename ?? null;
    const here = file ? whereLocal(local, file) : null;
    const all = [...(local.controller ?? []), ...local.library];
    let where: Row["where"] = here;
    let target: AddTarget | null = null;
    if (here && file) {
      const r = all.find((x) => x.filename.toLowerCase() === file.toLowerCase());
      target = { filename: file, name: r?.name ?? file.replace(/\.c4[zi]$/i, ""), manufacturer: r?.manufacturer ?? d.manufacturer, model: r?.model ?? d.model };
    } else {
      const docs = onlineByType.get(d.device_type);
      if (docs === "error") where = "unknown";
      else if (docs) {
        const doc = named ? docs.find((x) => x.filename.toLowerCase() === named.toLowerCase()) : docs[0];
        where = doc ? "online" : "unknown";
        if (doc) target = { filename: doc.filename, name: doc.name, manufacturer: doc.manufacturer, model: doc.model };
      }
    }
    return { d, type: typeWord(d.device_type), file: target?.filename ?? named, where, target };
  }), [found, local, online]);

  const why = shell.writable ? undefined : `${shell.director?.name ?? "This Director"} is read-only`;
  const addRow = (r: Row) => { if (r.target && !why) void add(r.target, { identify: r.d.identity, at: r.d.address }); };

  const columns = useMemo(() => [
    col.accessor("type", {
      header: "Type", meta: { width: "22%", hideBelow: 470 },
      cell: (c) => {
        const r = c.row.original;
        const seen = r.d.seenBy.length === 2 ? "Director and this computer" : r.d.seenBy[0] === "director" ? "Director (not this computer's scan)" : "this computer's SDDP scan";
        return (
          <Tip text={<>{r.d.device_type}<br />Seen by {seen}</>}>
            <span className="row nowrap ellip"><DriverIcon driver={r.file} proxy={r.d.device_type} size={15} /><span className="ellip cap">{c.getValue()}</span></span>
          </Tip>
        );
      },
    }),
    col.accessor((r) => r.d.manufacturer, { id: "mfr", header: "Manufacturer", meta: { width: "22%", hideBelow: 400 }, cell: (c) => <span className="ellip">{c.getValue() || "—"}</span> }),
    col.accessor((r) => r.d.model, {
      id: "model", header: "Model",
      cell: (c) => {
        const r = c.row.original;
        // Narrow pane: the type and maker columns are hidden, so this one says what it is.
        const narrow = !c.table.getColumn("type")?.getIsVisible();
        const text = narrow ? [r.d.manufacturer, r.d.model].filter(Boolean).join(" ") || r.type : c.getValue() || "—";
        return (
          <span className="row nowrap ellip">
            {narrow && <DriverIcon driver={r.file} proxy={r.d.device_type} size={15} />}
            <span className="ellip" title={`${text} · ${r.d.device_type}`}>{text}</span>
          </span>
        );
      },
    }),
    col.accessor((r) => r.d.address, {
      id: "address", header: "Address", meta: { width: 104, className: "mono" },
      sortingFn: (a, b) => a.original.d.address.localeCompare(b.original.d.address, undefined, { numeric: true }),
    }),
    col.accessor((r) => r.where ?? "", {
      id: "driver", header: "Driver", meta: { width: 92 },
      cell: (c) => {
        const r = c.row.original;
        if (!r.where) return <span className="dim small"><Spinner />checking</span>;
        return <Tip text={r.file ?? undefined}><span><Avail where={r.where} /></span></Tip>;
      },
    }),
    col.display({
      id: "act", meta: { width: 44, align: "right" },
      cell: (c) => {
        const r = c.row.original;
        if (r.target) {
          return (
            <Tip text={why ?? `Add ${r.target.name} to a room, identified at ${r.d.address}`}>
              <span><button className="icon-btn add-btn" aria-label="Add to room" disabled={!!why} onClick={() => addRow(r)}><Plus size={14} strokeWidth={2} /></button></span>
            </Tip>
          );
        }
        if (r.where === "unknown") {
          return <Tip text="Find a driver"><button className="icon-btn" aria-label="Find driver" onClick={() => onFind(r.d.device_type)}><PackageSearch size={14} strokeWidth={1.8} /></button></Tip>;
        }
        return null;
      },
    }),
  ], [why, onFind, add]);

  return (
    <>
      <div className="filters">
        <button className="act small" onClick={() => void rescan()} disabled={scanning}>
          {scanning ? <Spinner /> : <Radar size={13} strokeWidth={1.8} />}{scanning ? "Scanning…" : "Rescan"}
        </button>
        <span className="dim small">{net.data || scan ? `${plural(rows.length, "device")} not in the project` : ""}</span>
      </div>
      {net.error && !net.data && <Failure error={net.error} retry={net.reload} />}
      {scanError && <p className="hint pad-t warn">The SDDP scan failed: {scanError}</p>}
      {!net.data && !scan && !net.error
        ? <div className="loading"><Spinner size="lg" /><span>Listening for devices…</span></div>
        : (
          <DataTable data={rows} columns={columns} rowId={(r) => r.d.address} label="Discovered devices" sort={[{ id: "address", desc: false }]}
                     selected={picked} onSelect={(r) => setPicked(r.d.address)} onActivate={addRow}
                     empty={scanning ? <span className="dim"><Spinner />Listening for devices…</span> : <p className="empty">Everything on the network is in the project.</p>} />
        )}
      {(() => {
        const r = rows.find((x) => x.d.address === picked);
        if (!r) return null;
        return (
          <div className="drv-detail">
            <div className="drv-facts">
              <span className="k">Type</span><span className="mono">{r.d.device_type}</span>
              {r.d.host && <><span className="k">Host</span><span className="mono">{r.d.host}</span></>}
              <span className="k">Driver</span>{r.file ? <code>{r.file}</code> : <span className="dim">none found</span>}
            </div>
            <div className="row">
              {r.target && <Tip text={why}><span><button className="act small primary" disabled={!!why} onClick={() => addRow(r)}><Plus size={13} strokeWidth={1.8} />Add to room…</button></span></Tip>}
              {r.where !== "controller" && r.where !== "library" && (
                <button className="act small" onClick={() => onFind(r.d.device_type)}><PackageSearch size={13} strokeWidth={1.8} />Find driver</button>
              )}
            </div>
          </div>
        );
      })()}
    </>
  );
}
