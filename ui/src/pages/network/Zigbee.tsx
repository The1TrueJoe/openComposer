import { RadioTower, RefreshCw, Trash2, Wifi } from "lucide-react";
import { useMemo, useState } from "react";
import { api, type ZigbeeAction, type ZigbeeQuery } from "../../api";
import { JsonTree } from "../../components/JsonTree";
import { useDialog } from "../../components/Dialogs";
import { Select, Spinner, Tabs } from "../../components/controls";
import { Failure } from "../../components/shell";
import type { Shell } from "../../lib/shell";
import { cx, useLoad } from "../../lib/ui";

const QUERIES: { id: ZigbeeQuery; label: string }[] = [
  { id: "nodes", label: "Nodes" }, { id: "mesh", label: "Mesh" }, { id: "server", label: "Server" }, { id: "zaps", label: "ZAPs" },
];

/** The controller's Zigbee answers are its XML turned into JSON, in whatever shape that XML
 *  had. A list of records is drawn as a table; anything else as a tree. The config actions
 *  (permit-join, remove a node, identify an access point) go through the approval flow like
 *  any other change. */
export function Zigbee({ shell }: { shell: Shell }) {
  const [q, setQ] = useState<ZigbeeQuery>("nodes");
  const res = useLoad(() => api.zigbee(q), [q, shell.director?.id]);
  const table = useMemo(() => (res.data == null ? null : findRecords(res.data)), [res.data]);
  const [sortBy, setSortBy] = useState("");
  const { confirm } = useDialog();
  const server = shell.info?.device_id;

  const act = (action: ZigbeeAction, reason: string) =>
    server != null && shell.propose([{ op: "zigbee_control", iddevice: server, action }], reason);

  const rows = useMemo(() => {
    if (!table || !sortBy) return table?.rows ?? [];
    const num = (v: unknown) => Number(v);
    return [...table.rows].sort((a, b) => {
      const [x, y] = [a[sortBy], b[sortBy]];
      return Number.isFinite(num(x)) && Number.isFinite(num(y)) ? num(x) - num(y) : String(x ?? "").localeCompare(String(y ?? ""));
    });
  }, [table, sortBy]);

  // A per-row action only when the record carries something that looks like a Zigbee address.
  const rowAction = (r: Rec) => {
    const addr = addressOf(r);
    if (server == null || !addr) return null;
    if (q === "zaps") {
      return <button className="act small" onClick={() => act({ zigbee: "identify_access_point", address: addr }, "Identify a Zigbee access point")}>
        <Wifi size={13} strokeWidth={1.8} />Identify</button>;
    }
    if (q === "nodes") {
      return <button className="act small danger" onClick={async () => {
        if (await confirm({ title: "Remove this node from the mesh?", description: `Zigbee ${addr} will be told to leave. This does not remove the device from the project.`, confirmLabel: "Remove", danger: true }))
          await act({ zigbee: "remove_node", address: addr }, "Remove a Zigbee node from the mesh");
      }}><Trash2 size={13} strokeWidth={1.8} />Remove</button>;
    }
    return null;
  };
  const withActions = (q === "nodes" || q === "zaps") && server != null;

  return (
    <div className="zigbee">
      <Tabs tabs={QUERIES} value={q} onChange={setQ}>
        <span className="grow" />
        {res.loading ? <Spinner /> : <button className="icon-btn" aria-label="Ask again" onClick={res.reload}><RefreshCw size={13} strokeWidth={1.8} /></button>}
      </Tabs>

      {server != null && (
        <div className="filters">
          <button className="act small" onClick={() => act({ zigbee: "permit_join", seconds: 60 }, "Open the Zigbee mesh to pair a device")}>
            <RadioTower size={13} strokeWidth={1.8} />Open to pair (60s)
          </button>
          <button className="act small" onClick={() => act({ zigbee: "permit_join", seconds: 0 }, "Close the Zigbee join window")}>Close</button>
          <span className="spread" />
          <span className="dim small">Mesh changes go through approval. Method names are not yet verified against a live Control4 network.</span>
        </div>
      )}

      {res.error && <Failure error={res.error} retry={res.reload} />}
      {table && (
        <>
          <div className="filters">
            <span className="dim">{table.rows.length} {table.name}</span>
            <span className="spread" />
            <Select value={sortBy} onValueChange={setSortBy} label="Sort" options={[{ value: "", label: "Original order" }, ...table.columns.map((c) => ({ value: c, label: `Sort by ${label(c)}` }))]} />
          </div>
          <table className="grid-table">
            <thead><tr>{table.columns.map((c) => <th key={c}>{label(c)}</th>)}{withActions && <th />}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={cx(String(r["@online"] ?? r.online) === "false" && "dimmed")}>
                  {table.columns.map((c) => <td key={c} className={cx(cellMono(c) && "mono")}>{cell(r[c])}</td>)}
                  {withActions && <td className="right">{rowAction(r)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {res.data != null && (
        <details className="raw" open={!table}>
          <summary>{table ? "Raw answer" : "Answer"}</summary>
          <JsonTree value={res.data} />
        </details>
      )}
    </div>
  );
}

type Rec = Record<string, unknown>;

/** The first list of objects in the answer, depth first, with the union of their keys. */
function findRecords(v: unknown, name = "records"): { name: string; columns: string[]; rows: Rec[] } | null {
  if (Array.isArray(v)) {
    const rows = v.filter((x): x is Rec => !!x && typeof x === "object" && !Array.isArray(x));
    if (rows.length && rows.length === v.length) {
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      return { name, columns, rows };
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const hit = findRecords(x, `${k}s`);
      if (hit) return hit;
    }
  }
  return null;
}

/** A node/AP's Zigbee address, under whatever key the controller's XML used for it. An
 *  explicit address-like key wins; otherwise an `id` that looks like a Zigbee EUI (the node
 *  tables key the EUI64 as `@id`), but never a plain numeric project id. */
function addressOf(r: Rec): string | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const explicit = Object.keys(r).find((k) => /^@?(address|eui|eui64|mac|shortid|nodeid)$/i.test(k));
  if (explicit) return str(r[explicit]) ?? (typeof r[explicit] === "number" ? String(r[explicit]) : null);
  const id = str(r["@id"]) ?? str(r.id);
  return id && /^[0-9a-f]{12,}$/i.test(id.replace(/[:x]/gi, "")) ? id : null;
}

const label = (k: string) => k.replace(/^@/, "").replace(/_/g, " ");
const cellMono = (k: string) => /id|rssi|lqi|parent|firmware|address/i.test(k);
const cell = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
