import { Fingerprint, PackageSearch, Plus, Radar } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api, errText, type Announcement, type DriverDoc } from "../../api";
import { Tip, useDialog } from "../../components/Dialogs";
import { Select, Spinner, Tabs } from "../../components/controls";
import { Failure, Loading } from "../../components/shell";
import { identityFor } from "../../lib/network";
import { indexTree, ofKind } from "../../lib/project";
import type { Shell } from "../../lib/shell";
import { cx, useLoad } from "../../lib/ui";
import { Zigbee } from "./Zigbee";

type Tab = "project" | "sddp" | "zigbee";

/** Network bindings a device's driver usually declares for its IP identity. Used when the
 *  driver doesn't show one we can read. */
const DEFAULT_BINDING = 6001;

/** What Director knows about the network, what is out there that it doesn't, and Zigbee. */
export function NetworkPage({ shell }: { shell: Shell }) {
  const [tab, setTab] = useState<Tab>("project");
  return (
    <div className="page">
      <Tabs className="page-tabs" value={tab} onChange={setTab}
            tabs={[{ id: "project", label: "In the project" }, { id: "sddp", label: "SDDP scan" }, { id: "zigbee", label: "Zigbee" }]} />
      <div className="page-body">
        {tab === "project" && <ProjectNetwork shell={shell} onScan={() => setTab("sddp")} />}
        {tab === "sddp" && <Scan shell={shell} />}
        {tab === "zigbee" && <Zigbee />}
      </div>
    </div>
  );
}

function ProjectNetwork({ shell, onScan }: { shell: Shell; onScan: () => void }) {
  const res = useLoad(() => api.network(), [shell.rev, shell.director?.id]);
  if (!res.data) return res.error ? <Failure error={res.error} retry={res.reload} /> : <Loading what="Asking Director" />;
  const n = res.data;
  return (
    <>
      <h3 className="h">Identified <span className="n">{n.identified.length}</span></h3>
      <table className="grid-table">
        <thead><tr><th>Device</th><th>Type</th><th>Address</th><th>UUID</th><th>Search type</th><th>Status</th></tr></thead>
        <tbody>
          {n.identified.map((x, i) => (
            <tr key={i}>
              <td><b>{x.device.name}</b><div className="dim small">{x.device.path.split(" › ").slice(0, -1).join(" › ")}</div></td>
              <td>{x.address_type === 1 ? "IP / SDDP" : x.address_type === 3 ? "Zigbee" : `type ${x.address_type}`}</td>
              <td className="mono">{x.address}</td>
              <td className="mono dim">{x.uuid}</td>
              <td className="mono">{x.search_type || "—"}</td>
              <td><span className="row"><span className={cx("dot", x.status === "online" && "on")} />{x.status || "—"}</span></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="h">Discovered, not in the project <span className="n">{n.discovered_not_in_project.length}</span></h3>
      <p className="hint flush">Director sees these on the network but no device in the project is identified as them. Scan SDDP to see manufacturer and model, find a driver, and add one.</p>
      {n.discovered_not_in_project.length ? (
        <table className="grid-table">
          <thead><tr><th>Device type</th><th>Address</th><th>UUID</th><th /></tr></thead>
          <tbody>
            {n.discovered_not_in_project.map((d) => (
              <tr key={d.uuid}>
                <td className="mono">{d.device_type}</td>
                <td className="mono">{d.address}</td>
                <td className="mono dim">{d.uuid}</td>
                <td className="right"><button className="act small" onClick={onScan}><Radar size={13} strokeWidth={1.8} />Scan to add</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="empty">Everything Director discovered is in the project.</p>}
    </>
  );
}

function Scan({ shell }: { shell: Shell }) {
  const [seconds, setSeconds] = useState("4");
  const [found, setFound] = useState<Announcement[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const net = useLoad(() => api.network(), [shell.rev, shell.director?.id]);
  const tree = useLoad(() => api.tree(), [shell.rev, shell.director?.id]);
  const known = useMemo(() => new Map((net.data?.identified ?? []).map((x) => [x.uuid, x.device.name])), [net.data]);
  const idx = useMemo(() => indexTree(tree.data?.tree ?? null), [tree.data]);
  const { ask, choose } = useDialog();

  const scan = async () => {
    setScanning(true);
    try {
      setFound((await api.sddp(Number(seconds))).devices);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setScanning(false);
    }
  };

  const identify = async (a: Announcement, device: { id: number; name: string }) => {
    // Use the driver's own network connection if it shows one; most IP drivers declare 6001.
    const item = await api.item(device.id).catch(() => null);
    const binding = item?.network_connections?.[0]?.id
      ?? item?.connections.find((c) => c.id >= 6000 && c.id < 7000)?.id ?? DEFAULT_BINDING;
    const id = identityFor(a, net.data?.discovered ?? []);
    await shell.propose([{ op: "add_network_binding", device: device.id, binding, address_type: 1, address: id.address, search_type: id.search_type }],
      `Identify ${device.name} as the ${a.manufacturer} ${a.model} at ${a.address}.`);
  };

  const addAndIdentify = async (a: Announcement, d: DriverDoc) => {
    const room = await choose({ title: `Add ${d.name} to…`, options: ofKind(idx, "room").map((r) => ({ id: String(r.node.id), label: r.node.name, detail: r.location })) });
    if (!room) return;
    const name = await ask({ title: "Name the new device", initial: a.model ? `${a.manufacturer} ${a.model}` : d.name, confirmLabel: "Propose" });
    if (!name) return;
    // One approval: install the file if the controller lacks it, add, and identify.
    await shell.addDriver({ room: Number(room), filename: d.filename, name, identify: identityFor(a, net.data?.discovered ?? []),
      reason: `Add the ${a.manufacturer} ${a.model} found at ${a.address}.` });
  };

  const identifyExisting = async (a: Announcement) => {
    const devices = ofKind(idx, "device");
    const picked = await choose({ title: `Which device is ${a.manufacturer} ${a.model} (${a.address})?`,
      options: devices.map((d) => ({ id: String(d.node.id), label: d.node.name, detail: `${d.location} · ${d.node.driver ?? ""}` })) });
    const dev = devices.find((d) => String(d.node.id) === picked);
    if (dev) await identify(a, { id: dev.node.id, name: dev.node.name });
  };

  return (
    <>
      <div className="filters flush">
        <button className="act primary" onClick={scan} disabled={scanning}>{scanning ? <Spinner /> : <Radar size={14} strokeWidth={1.8} />}Scan</button>
        <Select value={seconds} onValueChange={setSeconds} label="Listen for" options={["2", "4", "8", "15"].map((s) => ({ value: s, label: `Listen ${s} s` }))} />
        <span className="hint flush">Listens for SDDP on this computer's network — the same announcements Director uses to find devices.</span>
      </div>
      {!found && !scanning && <p className="empty">Not scanned yet.</p>}
      {scanning && !found && <Loading what={`Listening for ${seconds} seconds`} />}
      {found && (
        <table className="grid-table">
          <thead><tr><th>Type</th><th>IP</th><th>Manufacturer</th><th>Model</th><th>Driver</th><th>Status</th><th /></tr></thead>
          <tbody>
            {found.map((a) => {
              const inProject = known.get(a.host) ?? known.get(identityFor(a, net.data?.discovered ?? []).address);
              return [
                <tr key={a.host} className={cx(open === a.host && "on")}>
                  <td className="mono">{a.device_type}</td>
                  <td className="mono">{a.address}</td>
                  <td>{a.manufacturer || "—"}</td>
                  <td>{a.model || "—"}</td>
                  <td className="mono">{a.driver || <span className="dim">—</span>}</td>
                  <td>{inProject ? <span className="tag on">{inProject}</span> : <span className="tag warn">not in project</span>}</td>
                  <td className="right nowrap">
                    {!inProject && <>
                      <button className="act small" onClick={() => setOpen(open === a.host ? null : a.host)}><PackageSearch size={13} strokeWidth={1.8} />Find driver</button>
                      <Tip text={shell.writable ? "Identify a device already in the project as this one" : "This Director is read-only"}>
                        <span><button className="act small" disabled={!shell.writable} onClick={() => identifyExisting(a)}><Fingerprint size={13} strokeWidth={1.8} />Identify…</button></span>
                      </Tip>
                    </>}
                  </td>
                </tr>,
                open === a.host && <tr key={`${a.host}-drivers`} className="sub"><td colSpan={7}><Drivers a={a} writable={shell.writable} onAdd={(d) => addAndIdentify(a, d)} /></td></tr>,
              ];
            })}
          </tbody>
        </table>
      )}
      {found && !found.length && <p className="empty">Nothing answered.</p>}
    </>
  );
}

/** Drivers whose SDDP search type matches what the device announced. */
function Drivers({ a, writable, onAdd }: { a: Announcement; writable: boolean; onAdd: (d: DriverDoc) => void }) {
  const res = useLoad(() => api.searchDrivers({ search_type: a.device_type, rows: 20 }), [a.device_type]);
  if (!res.data) return res.error ? <p className="err">{res.error}</p> : <Loading what="Searching the driver database" />;
  if (!res.data.drivers.length) return <p className="empty">No driver in the database declares <code>{a.device_type}</code>. Try a text search in Design › Add devices › Drivers.</p>;
  return (
    <div className="drv-matches">
      {res.data.drivers.map((d) => (
        <div key={d.filename} className="cand">
          <div>
            <b>{d.name}</b> <span className="dim">{d.manufacturer} · {d.model}</span>
            <div className="mono dim small">{d.filename} · {d.control_method}{d.certified ? " · certified" : ""}{a.driver === d.filename ? " · announced by the device" : ""}</div>
          </div>
          <Tip text={writable ? "Add a device with this driver and identify it as this one — one approval, installing the file first if needed" : "This Director is read-only"}>
            <span><button className="act small" disabled={!writable} onClick={() => onAdd(d)}><Plus size={13} strokeWidth={1.8} />Add + identify</button></span>
          </Tip>
        </div>
      ))}
    </div>
  );
}
