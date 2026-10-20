import { PackageSearch, Plus, Radar } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errText, type Announcement } from "../../api";
import { Tip } from "../../components/Dialogs";
import { Spinner } from "../../components/controls";
import { KindIcon } from "../../components/icons";
import { Failure } from "../../components/shell";
import { unidentified, type Unidentified } from "../../lib/network";
import type { Shell } from "../../lib/shell";
import { plural, useLoad } from "../../lib/ui";
import type { Add, AddTarget } from "./AddDevices";
import { Avail } from "./DriverSearch";
import { localFor, whereLocal, type Local, type Where } from "./drivers";

// The last scan, kept while the app runs: listening takes seconds, and coming back to the
// pane shouldn't mean waiting again. Rescan replaces it.
let lastScan: Announcement[] | null = null;

/** Devices on the network that no project device is identified as: Director's own list, and
 *  what this computer hears over SDDP (which adds manufacturer, model and driver file). */
export function Discovered({ shell, local, add, onFind }: {
  shell: Shell; local: Local; add: Add; onFind: (searchType: string) => void;
}) {
  const net = useLoad(() => api.network(), [shell.rev, shell.director?.id]);
  const [scan, setScan] = useState<Announcement[] | null>(lastScan);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

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

  const rows = unidentified(net.data, scan ?? undefined);

  return (
    <>
      <div className="filters">
        <button className="act small" onClick={() => void rescan()} disabled={scanning}>
          {scanning ? <Spinner /> : <Radar size={13} strokeWidth={1.8} />}{scanning ? "Scanning…" : "Rescan"}
        </button>
        <span className="dim small">{net.data || scan ? `${plural(rows.length, "device")} not in the project` : ""}</span>
      </div>
      <div className="panel-body">
        {net.error && !net.data && <Failure error={net.error} retry={net.reload} />}
        {scanError && <p className="hint pad-t warn">The SDDP scan failed: {scanError}</p>}
        {!rows.length && !scanning && (net.data || scan) && <p className="empty pad">Everything on the network is in the project.</p>}
        {!rows.length && scanning && <p className="loading"><Spinner />Listening for devices…</p>}
        {rows.map((d) => <Row key={d.address} d={d} local={local} shell={shell} add={add} onFind={onFind} />)}
      </div>
    </>
  );
}

function Row({ d, local, shell, add, onFind }: { d: Unidentified; local: Local; shell: Shell; add: Add; onFind: (t: string) => void }) {
  // The driver: the one the device names, or failing that one here that declares its type.
  const named = d.driver || null;
  const match = named ? null : localFor(local, d.device_type);
  const file = named ?? match?.filename ?? null;
  const here = file ? whereLocal(local, file) : null;
  // Not here: does the database know it (or, for a device that names nothing, any driver)?
  const online = useLoad(() => (here ? Promise.resolve(null) : api.searchDrivers({ search_type: d.device_type, rows: 10 })), [here, d.device_type]);

  let where: Where | "unknown" | null = here;
  let target: AddTarget | null = null;
  const all = [...(local.controller ?? []), ...local.library];
  if (here && file) {
    const r = all.find((x) => x.filename.toLowerCase() === file.toLowerCase());
    target = { filename: file, name: r?.name ?? file.replace(/\.c4[zi]$/i, ""), manufacturer: r?.manufacturer ?? d.manufacturer, model: r?.model ?? d.model };
  } else if (online.data) {
    const doc = named ? online.data.drivers.find((x) => x.filename.toLowerCase() === named.toLowerCase()) : online.data.drivers[0];
    where = doc ? "online" : "unknown";
    if (doc) target = { filename: doc.filename, name: doc.name, manufacturer: doc.manufacturer, model: doc.model };
  } else if (online.error) {
    where = "unknown";
  }

  const title = [d.manufacturer, d.model].filter(Boolean).join(" ") || d.device_type;
  const why = shell.writable ? undefined : `${shell.director?.name ?? "This Director"} is read-only`;
  const seen = d.seenBy.length === 2 ? "Director and this computer" : d.seenBy[0] === "director" ? "Director (not this computer's scan)" : "this computer's SDDP scan";

  return (
    <div className="disc">
      <div className="disc-top">
        <span className="tw-ic"><KindIcon kind="device" driver={file ?? d.device_type} /></span>
        <b title={title}>{title}</b>
        <span className="spread">{where ? <Avail where={where} /> : <span className="dim small"><Spinner />checking</span>}</span>
      </div>
      <Tip text={`Seen by ${seen}`}><div className="disc-sub mono">{d.address} · {d.device_type}</div></Tip>
      {(target?.filename ?? named) && (
        <div className="drv-file mono">{target?.filename ?? named}{!named && target && <span className="dim"> · matches its type</span>}</div>
      )}
      <div className="row disc-acts">
        {target && (
          <Tip text={why}>
            <span><button className="act small primary" disabled={!!why}
                          onClick={() => void add(target, { identify: d.identity, at: d.address })}>
              <Plus size={13} strokeWidth={1.8} />Add to room…
            </button></span>
          </Tip>
        )}
        {where !== "controller" && where !== "library" && (
          <button className="act small" onClick={() => onFind(d.device_type)}><PackageSearch size={13} strokeWidth={1.8} />Find driver</button>
        )}
      </div>
    </div>
  );
}
