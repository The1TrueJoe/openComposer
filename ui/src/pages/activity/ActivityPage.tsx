import { Check, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type Activity } from "../../api";
import { SourceBadge } from "../../components/DiffView";
import { Select } from "../../components/controls";
import { cx, time, useBackendEvent } from "../../lib/ui";

/** Matches the backend's ring buffer, so the table never holds more than it would. */
const KEEP = 500;

/** Every tool call — from MCP clients, the in-app agent and this app's own writes — as it happens. */
export function ActivityPage() {
  const [rows, setRows] = useState<Activity[]>([]);
  const [source, setSource] = useState("");
  const [text, setText] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);

  useEffect(() => { api.activity().then((a) => setRows([...a].reverse()), () => {}); }, []);
  useBackendEvent("activity", (a) => setRows((r) => (r.some((x) => x.seq === a.seq) ? r : [a, ...r].slice(0, KEEP))));

  const sources = useMemo(() => [...new Set(rows.map((r) => r.source))].sort(), [rows]);
  const shown = useMemo(() => {
    const q = text.trim().toLowerCase();
    return rows.filter((r) => (!source || r.source === source) && (!failedOnly || !r.ok) && (!q || `${r.tool} ${r.summary}`.toLowerCase().includes(q)));
  }, [rows, source, text, failedOnly]);

  return (
    <div className="panel full">
      <div className="filters">
        <div className="search-box inline">
          <Search size={13} strokeWidth={1.8} />
          <input placeholder="Tool or detail" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <Select value={source} onValueChange={setSource} label="Source" options={[{ value: "", label: "All sources" }, ...sources.map((s) => ({ value: s, label: s }))]} />
        <Select value={failedOnly ? "failed" : ""} onValueChange={(v) => setFailedOnly(v === "failed")} label="Result"
                options={[{ value: "", label: "Any result" }, { value: "failed", label: "Failed only" }]} />
        <span className="spread dim">{shown.length} calls · live</span>
      </div>
      <div className="panel-body">
        <table className="grid-table sticky activity">
          <thead><tr><th>Time</th><th>Source</th><th>Tool</th><th>Detail</th><th>Result</th><th className="right">ms</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.seq} className={cx(!r.ok && "failed")}>
                <td className="mono dim nowrap">{time(r.at)}</td>
                <td><SourceBadge source={r.source} /></td>
                <td className="mono">{r.tool}</td>
                <td className="mono dim">{r.summary || "—"}</td>
                <td>{r.ok ? <Check size={14} strokeWidth={1.8} className="ok" /> : <span className="err row"><X size={14} strokeWidth={1.8} />failed</span>}</td>
                <td className="mono right dim">{r.ms}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="empty pad">{rows.length ? "Nothing matches these filters." : "No tool calls yet. Connect an MCP client or ask the agent something."}</p>}
      </div>
    </div>
  );
}
