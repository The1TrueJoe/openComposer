import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { api, type ZigbeeQuery } from "../../api";
import { JsonTree } from "../../components/JsonTree";
import { Select, Spinner, Tabs } from "../../components/controls";
import { Failure } from "../../components/shell";
import { cx, useLoad } from "../../lib/ui";

const QUERIES: { id: ZigbeeQuery; label: string }[] = [
  { id: "nodes", label: "Nodes" }, { id: "mesh", label: "Mesh" }, { id: "server", label: "Server" }, { id: "zaps", label: "ZAPs" },
];

/** The controller's Zigbee answers are its XML turned into JSON, in whatever shape that XML
 *  had. A list of records is drawn as a table; anything else as a tree. */
export function Zigbee() {
  const [q, setQ] = useState<ZigbeeQuery>("nodes");
  const res = useLoad(() => api.zigbee(q), [q]);
  const table = useMemo(() => (res.data == null ? null : findRecords(res.data)), [res.data]);
  const [sortBy, setSortBy] = useState("");

  const rows = useMemo(() => {
    if (!table || !sortBy) return table?.rows ?? [];
    const num = (v: unknown) => Number(v);
    return [...table.rows].sort((a, b) => {
      const [x, y] = [a[sortBy], b[sortBy]];
      return Number.isFinite(num(x)) && Number.isFinite(num(y)) ? num(x) - num(y) : String(x ?? "").localeCompare(String(y ?? ""));
    });
  }, [table, sortBy]);

  return (
    <div className="zigbee">
      <Tabs tabs={QUERIES} value={q} onChange={setQ}>
        <span className="grow" />
        {res.loading ? <Spinner /> : <button className="icon-btn" aria-label="Ask again" onClick={res.reload}><RefreshCw size={13} strokeWidth={1.8} /></button>}
      </Tabs>
      {res.error && <Failure error={res.error} retry={res.reload} />}
      {table && (
        <>
          <div className="filters">
            <span className="dim">{table.rows.length} {table.name}</span>
            <span className="spread" />
            <Select value={sortBy} onValueChange={setSortBy} label="Sort" options={[{ value: "", label: "Original order" }, ...table.columns.map((c) => ({ value: c, label: `Sort by ${label(c)}` }))]} />
          </div>
          <table className="grid-table">
            <thead><tr>{table.columns.map((c) => <th key={c}>{label(c)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={cx(String(r["@online"] ?? r.online) === "false" && "dimmed")}>
                  {table.columns.map((c) => <td key={c} className={cx(cellMono(c) && "mono")}>{cell(r[c])}</td>)}
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

const label = (k: string) => k.replace(/^@/, "").replace(/_/g, " ");
const cellMono = (k: string) => /id|rssi|lqi|parent|firmware|address/i.test(k);
const cell = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
