import { ArrowDownToLine, ArrowUpFromLine, Link2, Search, Unlink } from "lucide-react";
import { useMemo, useState } from "react";
import { api, type ConnectionRow } from "../../api";
import { Tip } from "../../components/Dialogs";
import { Grip, MainPane, Panes, SidePane } from "../../components/Panes";
import { Select, Switch } from "../../components/controls";
import { Failure, Loading } from "../../components/shell";
import { candidates, connectOp, disconnectOp } from "../../lib/connections";
import type { Shell } from "../../lib/shell";
import { cx, plural, useLoad } from "../../lib/ui";

type Role = "" | "input" | "output";
const key = (r: ConnectionRow) => `${r.device.id}:${r.connection.id}`;

/** Every connection definition in the project: filter it down, pick one end, and the other
 *  ends it could join are listed beside it. */
export function ConnectionsPage({ shell }: { shell: Shell }) {
  const res = useLoad(() => api.connections(), [shell.rev, shell.director?.id]);
  const [cls, setCls] = useState("");
  const [role, setRole] = useState<Role>("");
  const [text, setText] = useState("");
  const [free, setFree] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  const all = useMemo(() => res.data?.connections ?? [], [res.data]);
  const classes = useMemo(() => [...new Set(all.flatMap((r) => r.connection.classes))].sort(), [all]);
  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    return all.filter((r) =>
      (!cls || r.connection.classes.includes(cls))
      && (!role || r.connection.role === role)
      && (!free || !r.connection.connected_to.length)
      && (!q || `${r.device.name} ${r.device.room ?? ""} ${r.connection.name}`.toLowerCase().includes(q)));
  }, [all, cls, role, free, text]);
  const sel = all.find((r) => key(r) === picked) ?? null;
  const options = useMemo(() => (sel ? candidates(all, sel) : []), [all, sel]);

  if (!res.data) return res.error ? <Failure error={res.error} retry={res.reload} /> : <Loading what="Reading connections" />;

  return (
    <Panes id="connections">
      <MainPane id="table">
        <div className="panel">
          <div className="filters">
            <div className="search-box inline">
              <Search size={13} strokeWidth={1.8} />
              <input placeholder="Device, room or connection" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
            <Select value={cls} onValueChange={setCls} label="Class" options={[{ value: "", label: "All classes" }, ...classes.map((c) => ({ value: c, label: c }))]} />
            <Select value={role} onValueChange={setRole} label="Direction"
                    options={[{ value: "", label: "Inputs and outputs" }, { value: "input", label: "Inputs" }, { value: "output", label: "Outputs" }]} />
            <label className="inline-switch"><Switch checked={free} onCheckedChange={setFree} label="Unconnected only" />Unconnected only</label>
            <span className="spread dim">{rows.length} of {all.length}</span>
          </div>
          <div className="panel-body">
            <table className="grid-table sticky">
              <thead><tr><th>Device</th><th>Connection</th><th>Classes</th><th>Connected to</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={key(r)} className={cx("pick", picked === key(r) && "on")} onClick={() => setPicked(key(r))}>
                    <td><b>{r.device.name}</b>{r.device.room && <div className="dim small">{r.device.room}</div>}</td>
                    <td>
                      <span className="conn-name">
                        {r.connection.role === "input" ? <ArrowDownToLine size={13} strokeWidth={1.8} className="dim" /> : <ArrowUpFromLine size={13} strokeWidth={1.8} className="dim" />}
                        {r.connection.name}<span className="dim mono small">#{r.connection.id}</span>
                      </span>
                    </td>
                    <td><span className="chips">{r.connection.classes.map((c) => <span key={c} className="chip cls">{c}</span>)}</span></td>
                    <td>
                      <span className="chips">
                        {r.connection.connected_to.map((p, i) => (
                          <span key={i} className="chip peer">
                            {p.device.name} › {p.connection ?? `#${p.binding}`}
                            {shell.writable && (
                              <Tip text="Disconnect">
                                <button className="chip-x" aria-label="Disconnect" onClick={(e) => {
                                  e.stopPropagation();
                                  void shell.propose([disconnectOp(r.device.id, r.connection.id, r.connection.role, p)]);
                                }}><Unlink size={11} strokeWidth={1.8} /></button>
                              </Tip>
                            )}
                          </span>
                        ))}
                        {!r.connection.connected_to.length && <span className="dim">—</span>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <p className="empty pad">No connections match these filters.</p>}
          </div>
        </div>
      </MainPane>
      <Grip />
      <SidePane id="compatible" side="right" title="Connect" defaultSize={320}>
        <div className="panel-body">
          {!sel && <p className="hint pad-t">Pick a connection to see what it can be connected to.</p>}
          {sel && (
            <>
              <div className="conn-sel">
                <span className="dim small">{sel.connection.role === "input" ? "Input" : "Output"} · {sel.connection.classes.join(" · ")}</span>
                <b>{sel.device.name} › {sel.connection.name}</b>
                {sel.connection.role === "input" && sel.connection.connected_to.length > 0 && (
                  <p className="warn small">Already fed by {sel.connection.connected_to[0].device.name}. Disconnect it first — an input takes one provider.</p>
                )}
              </div>
              <div className="group">{plural(options.length, sel.connection.role === "input" ? "compatible output" : "free compatible input")}</div>
              {options.map((o) => (
                <div key={key(o)} className="cand">
                  <div>
                    <b>{o.device.name}</b> › {o.connection.name}
                    <div className="dim small">{[o.device.room, o.connection.classes.join(" · "), o.connection.connected_to.length ? `feeds ${o.connection.connected_to.length}` : ""].filter(Boolean).join(" · ")}</div>
                  </div>
                  <Tip text={shell.writable ? undefined : "This Director is read-only"}>
                    <span><button className="act small" disabled={!shell.writable || (sel.connection.role === "input" && sel.connection.connected_to.length > 0)}
                                  onClick={() => shell.propose([connectOp(sel, o)])}><Link2 size={13} strokeWidth={1.8} />Connect</button></span>
                  </Tip>
                </div>
              ))}
            </>
          )}
        </div>
      </SidePane>
    </Panes>
  );
}
