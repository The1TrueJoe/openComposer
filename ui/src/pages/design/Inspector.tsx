import { ArrowDownToLine, ArrowUpFromLine, FolderInput, Link2, Lock, Pencil, Plus, Trash2, Unlink, Wifi } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errText, type ConnectionDef, type ConnectionRow, type ItemDetail, type KindLabel, type PropertyView } from "../../api";
import { CodeRow } from "../../components/DiffView";
import { Tip, useDialog } from "../../components/Dialogs";
import { Select, Tabs } from "../../components/controls";
import { KindIcon } from "../../components/icons";
import { Failure, Loading } from "../../components/shell";
import { candidates, connectOp, disconnectOp } from "../../lib/connections";
import type { Shell } from "../../lib/shell";
import { cx, useLoad } from "../../lib/ui";

export interface ItemActions {
  rename: (id: number, name: string) => void;
  remove: (id: number, name: string, kind: KindLabel) => void;
  move: (id: number, name: string, kind: KindLabel) => void;
  addRoom: (floor: number) => void;
  addDevice: (room: number) => void;
}

type Tab = "properties" | "connections" | "network" | "variables" | "events";

/** Everything about one item, the way Composer's properties pane shows it. */
export function Inspector({ id, shell, onSelect, actions }: {
  id: number; shell: Shell; onSelect: (id: number) => void; actions: ItemActions;
}) {
  const item = useLoad(() => api.item(id), [id, shell.rev]);
  const [tab, setTab] = useState<Tab>("properties");
  const d = item.data?.id === id ? item.data : undefined;

  if (!d) return item.error ? <Failure error={item.error} retry={item.reload} /> : <Loading what="Reading the item" />;

  const conns = d.connections.length + d.children.reduce((n, c) => n + c.connections.length, 0);
  const tabs: { id: Tab; label: React.ReactNode }[] = [
    { id: "properties", label: <>Properties <span className="n">{d.properties.length}</span></> },
    { id: "connections", label: <>Connections <span className="n">{conns}</span></> },
    { id: "network", label: <>Network <span className="n">{d.network.length}</span></> },
    { id: "variables", label: <>Variables <span className="n">{d.variables.length}</span></> },
    { id: "events", label: <>Events <span className="n">{d.events.length}</span></> },
  ];
  const parts = d.path.split(" › ");
  const w = shell.writable;
  const why = w ? undefined : `${shell.director?.name ?? "This Director"} is read-only`;

  return (
    <div className="panel insp">
      <div className="crumbs">
        {parts.slice(0, -1).map((p, i) => <span key={i}>{p}<span className="sep">›</span></span>)}
        <b>{parts[parts.length - 1]}</b>
      </div>
      <div className="insp-head">
        <span className="insp-ic"><KindIcon kind={d.kind} driver={d.driver} size={20} /></span>
        <div className="insp-title">
          <h2>{d.name} <span className="tag">{d.kind}</span> <span className="dim mono small">#{d.id}</span></h2>
          {d.device ? (
            <div className="insp-facts">
              <span><b>{d.device.manufacturer}</b> {d.device.model}</span>
              {d.driver && <code>{d.driver}</code>}
              {d.device.version && <span className="dim">v{d.device.version}</span>}
              {d.device.control_method && <span className="tag">{d.device.control_method}</span>}
              {d.device.search_type && <span className="dim mono">{d.device.search_type}</span>}
            </div>
          ) : d.driver && <div className="insp-facts"><code>{d.driver}</code></div>}
        </div>
        <div className="insp-acts">
          {d.kind === "floor" && <Act icon={<Plus size={14} strokeWidth={1.8} />} label="Add room" why={why} onClick={() => actions.addRoom(d.id)} />}
          {d.kind === "room" && <Act icon={<Plus size={14} strokeWidth={1.8} />} label="Add device" why={why} onClick={() => actions.addDevice(d.id)} />}
          {d.kind !== "project" && <>
            <Act icon={<Pencil size={14} strokeWidth={1.8} />} label="Rename" why={why} onClick={() => actions.rename(d.id, d.name)} />
            {d.kind !== "proxy" && d.kind !== "agent" && d.kind !== "site" &&
              <Act icon={<FolderInput size={14} strokeWidth={1.8} />} label="Move" why={why} onClick={() => actions.move(d.id, d.name, d.kind)} />}
            {d.kind !== "proxy" && <Act icon={<Trash2 size={14} strokeWidth={1.8} />} label="Remove" danger why={why} onClick={() => actions.remove(d.id, d.name, d.kind)} />}
          </>}
        </div>
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="panel-body">
        {tab === "properties" && <Properties d={d} shell={shell} />}
        {tab === "connections" && <Connections d={d} shell={shell} onSelect={onSelect} />}
        {tab === "network" && <Network d={d} shell={shell} />}
        {tab === "variables" && <Variables d={d} />}
        {tab === "events" && <Events d={d} />}
      </div>
    </div>
  );
}

function Act({ icon, label, onClick, why, danger }: { icon: React.ReactNode; label: string; onClick: () => void; why?: string; danger?: boolean }) {
  return (
    <Tip text={why}>
      <span><button className={cx("act small", danger && "danger")} disabled={!!why} onClick={onClick}>{icon}{label}</button></span>
    </Tip>
  );
}

// ---- properties ----------------------------------------------------------------------------

/** Property types that are layout, not values (Composer draws them as section headings). */
const NOT_A_VALUE = new Set(["LABEL"]);
const isMasked = (v: string) => v.startsWith("••");

function Properties({ d, shell }: { d: ItemDetail; shell: Shell }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <>
      {d.properties.length ? (
        <table className="pg">
          <tbody>
            {d.properties.map((p) => {
              const type = (p.type ?? "").toUpperCase();
              // Only properties with a declared schema can be set: that is what the backend
              // checks a new value against.
              const editable = shell.writable && !!p.type && !p.readonly && !NOT_A_VALUE.has(type);
              return (
                <tr key={p.name} className={cx(editable && "editable", editing === p.name && "editing")}>
                  <td className="k">{p.name}</td>
                  <td className="v" onClick={() => editable && editing !== p.name && setEditing(p.name)}>
                    {editing === p.name
                      ? <PropEditor p={p} onCancel={() => setEditing(null)} onSubmit={async (value) => {
                          setEditing(null);
                          if (value !== p.value) await shell.propose([{ op: "set_property", device: d.id, name: p.name, value }]);
                        }} />
                      : <PropValue p={p} editable={editable} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p className="empty pad">No properties.</p>}
      {!!d.actions?.length && (
        <>
          <div className="section">Driver actions</div>
          <div className="chips pad-x">
            {d.actions.map((a) => <span key={a.command} className="chip" title={a.command}>{a.name}</span>)}
          </div>
          <p className="hint">Listed for reference: openComposer reads and rewires projects but doesn't run driver actions.</p>
        </>
      )}
    </>
  );
}

function PropValue({ p, editable }: { p: PropertyView; editable: boolean }) {
  const ro = p.readonly && <span className="tag">read-only</span>;
  const edit = editable && <Pencil size={12} strokeWidth={1.8} className="pv-edit" />;
  if (isMasked(p.value)) {
    return <span className="masked"><Lock size={12} strokeWidth={1.8} />{p.value}<span className="dim small">hidden</span>{edit}</span>;
  }
  const type = (p.type ?? "").toUpperCase();
  if (type === "LIST" && p.options?.length) {
    return (
      <span className="pv">
        <span>{p.value || <i className="dim">none</i>}</span>
        <Tip text={p.options.join(" · ")}><span className="dim small">of {p.options.length}</span></Tip>
        {ro}{edit}
      </span>
    );
  }
  if (type.startsWith("RANGED") && p.min != null && p.max != null) {
    const [lo, hi, v] = [Number(p.min), Number(p.max), Number(p.value)];
    const pct = hi > lo && Number.isFinite(v) ? Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)) : 0;
    return (
      <span className="pv">
        <span className="mono">{p.value}</span>
        <span className="range"><span style={{ width: `${pct}%` }} /></span>
        <span className="dim small">{p.min}–{p.max}</span>
        {ro}{edit}
      </span>
    );
  }
  if (type === "COLOR_SELECTOR") {
    return <span className="pv"><span className="swatch" style={{ background: `rgb(${p.value})` }} /><span className="mono">{p.value}</span>{ro}{edit}</span>;
  }
  return <span className="pv"><span className={cx(/^[\d.:]+$/.test(p.value) && "mono")}>{p.value || <i className="dim">empty</i>}</span>{ro}{edit}</span>;
}

/** One property being edited, with the control its schema calls for. The new value is
 *  proposed, not written: it shows on an approval card like any other change. */
function PropEditor({ p, onSubmit, onCancel }: { p: PropertyView; onSubmit: (v: string) => void; onCancel: () => void }) {
  const type = (p.type ?? "").toUpperCase();
  const masked = isMasked(p.value);
  // A hidden value is never put back in the field: the dots are not the value.
  const [value, setValue] = useState(masked ? "" : p.value);
  const numeric = type.includes("INTEGER") || type.includes("FLOAT");
  const problem = (() => {
    if (masked && !value) return "Type the new value";
    if (!numeric || value === "") return numeric ? "Needs a number" : null;
    const n = Number(value);
    if (!Number.isFinite(n) || (type.includes("INTEGER") && !Number.isInteger(n))) return type.includes("INTEGER") ? "Needs a whole number" : "Needs a number";
    if (p.min != null && n < Number(p.min)) return `At least ${p.min}`;
    if (p.max != null && n > Number(p.max)) return `At most ${p.max}`;
    return null;
  })();
  const submit = () => { if (!problem) onSubmit(value); };
  const keys = (e: React.KeyboardEvent) => {
    // Enter on the list's trigger opens the list; only a typed value submits on Enter.
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); submit(); }
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };

  return (
    <span className="pe" onKeyDown={keys}>
      {type === "LIST" && p.options?.length
        ? <Select value={value} onValueChange={setValue} label={p.name} options={p.options.map((o) => ({ value: o, label: o }))} />
        : <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-label={p.name}
                 type={masked ? "password" : "text"} inputMode={numeric ? "decimal" : undefined}
                 placeholder={masked ? "New value (the current one stays hidden)" : undefined}
                 className={cx(numeric && "mono", "pe-input")} />}
      {numeric && p.min != null && p.max != null && <span className="dim small">{p.min}–{p.max}</span>}
      {problem && value !== "" && <span className="err small">{problem}</span>}
      <button className="act small primary" disabled={!!problem || (!masked && value === p.value)} onClick={submit}>Propose</button>
      <button className="act small quiet" onClick={onCancel}>Cancel</button>
    </span>
  );
}

// ---- connections ---------------------------------------------------------------------------

function Connections({ d, shell, onSelect }: { d: ItemDetail; shell: Shell; onSelect: (id: number) => void }) {
  const owners = [
    { id: d.id, name: d.name, kind: d.kind as KindLabel, driver: d.driver, connections: d.connections },
    ...d.children.filter((c) => c.connections.length),
  ];
  if (!owners.some((o) => o.connections.length)) return <p className="empty pad">No connections.</p>;
  return (
    <>
      {owners.filter((o) => o.connections.length).map((o) => (
        <div key={o.id}>
          <div className="section row">
            <KindIcon kind={o.kind} driver={o.driver} />{o.name}{o.id !== d.id && <span className="tag">{o.kind}</span>}
          </div>
          <ConnTable owner={{ id: o.id, name: o.name, room: d.room }} defs={o.connections} shell={shell} onSelect={onSelect} />
        </div>
      ))}
    </>
  );
}

/** One owner's connection definitions with what each is connected to. Also used for proxies. */
function ConnTable({ owner, defs, shell, onSelect }: {
  owner: ConnectionRow["device"]; defs: ConnectionDef[]; shell: Shell; onSelect: (id: number) => void;
}) {
  const { choose } = useDialog();

  const connect = async (def: ConnectionDef) => {
    try {
      const from: ConnectionRow = { device: owner, connection: def };
      const all = (await api.connections()).connections;
      const options = candidates(all, from);
      if (!options.length) {
        toast.message(`Nothing in the project can take ${def.classes.join("/")} ${def.role === "input" ? "out" : "in"}.`);
        return;
      }
      const key = (r: ConnectionRow) => `${r.device.id}:${r.connection.id}`;
      const picked = await choose({
        title: `Connect ${owner.name} › ${def.name}`,
        description: def.role === "input" ? "Choose the output that feeds it." : "Choose a free input to feed.",
        options: options.map((r) => ({ id: key(r), label: `${r.device.name} › ${r.connection.name}`,
          detail: [r.device.room, r.connection.classes.join(" · "), r.connection.connected_to.length ? `already feeds ${r.connection.connected_to.length}` : ""].filter(Boolean).join(" · ") })),
      });
      const to = options.find((r) => key(r) === picked);
      if (to) await shell.propose([connectOp(from, to)]);
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <table className="grid-table">
      <thead><tr><th>Connection</th><th>Classes</th><th>Connected to</th><th /></tr></thead>
      <tbody>
        {defs.map((c) => (
          <tr key={c.id}>
            <td>
              <span className="conn-name">
                {c.role === "input" ? <ArrowDownToLine size={13} strokeWidth={1.8} className="dim" /> : <ArrowUpFromLine size={13} strokeWidth={1.8} className="dim" />}
                {c.name}<span className="dim mono small">#{c.id}</span>
              </span>
            </td>
            <td><span className="chips">{c.classes.map((k) => <span key={k} className="chip cls">{k}</span>)}</span></td>
            <td>
              <span className="chips">
                {c.connected_to.map((p, i) => (
                  <span key={i} className="chip peer">
                    <button className="link" onClick={() => onSelect(p.device.id)}>{p.device.name} › {p.connection ?? `#${p.binding}`}</button>
                    {shell.writable && (
                      <Tip text="Disconnect">
                        <button className="chip-x" aria-label="Disconnect"
                                onClick={() => shell.propose([disconnectOp(owner.id, c.id, c.role, p)])}><Unlink size={11} strokeWidth={1.8} /></button>
                      </Tip>
                    )}
                  </span>
                ))}
                {!c.connected_to.length && <span className="dim">—</span>}
              </span>
            </td>
            <td className="right">
              {shell.writable && (c.role === "output" || !c.connected_to.length) && (
                <button className="act small" onClick={() => connect(c)}><Link2 size={13} strokeWidth={1.8} />Connect…</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- network, variables, events ------------------------------------------------------------

function Network({ d, shell }: { d: ItemDetail; shell: Shell }) {
  const { confirm } = useDialog();
  if (!d.network.length) {
    return <p className="empty pad">Not identified on the network.{d.device?.search_type && <> Find it on the Network tab by its SDDP type <code>{d.device.search_type}</code>.</>}</p>;
  }
  return (
    <table className="grid-table">
      <thead><tr><th>Binding</th><th>Type</th><th>Address</th><th>UUID</th><th>Search type</th><th>Status</th><th /></tr></thead>
      <tbody>
        {d.network.map((n) => (
          <tr key={n.binding}>
            <td className="mono">{n.binding}</td>
            <td>{n.address_type === 1 ? "IP / SDDP" : n.address_type === 3 ? "Zigbee" : `type ${n.address_type}`}</td>
            <td className="mono">{n.address}</td>
            <td className="mono dim">{n.uuid}</td>
            <td className="mono">{n.search_type || "—"}</td>
            <td><span className="row"><span className={cx("dot", n.status === "online" && "on")} />{n.status || "—"}</span></td>
            <td className="right">
              {shell.writable && (
                <button className="act small danger" onClick={async () => {
                  if (await confirm({ title: `Remove the network identity of ${d.name}?`, description: "Director will stop looking for it at this address until it is identified again.", confirmLabel: "Propose removal", danger: true })) {
                    await shell.propose([{ op: "remove_network_binding", device: d.id, binding: n.binding }]);
                  }
                }}><Wifi size={13} strokeWidth={1.8} />Remove identity</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Variables({ d }: { d: ItemDetail }) {
  if (!d.variables.length) return <p className="empty pad">No variables.</p>;
  return (
    <table className="grid-table">
      <thead><tr><th>Name</th><th>Value</th><th>ID</th><th /></tr></thead>
      <tbody>
        {d.variables.map((v) => (
          <tr key={v.id} className={cx(v.hidden && "dimmed")}>
            <td className="mono">{v.name}{v.description && <div className="dim small">{v.description}</div>}</td>
            <td className="mono">{v.value === "" ? <i className="dim">empty</i> : v.value}</td>
            <td className="mono dim">{v.id}</td>
            <td>{v.readonly && <span className="tag">read-only</span>} {v.hidden && <span className="tag">hidden</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Events({ d }: { d: ItemDetail }) {
  if (!d.events.length) return <p className="empty pad">This driver declares no events.</p>;
  return (
    <div className="events">
      {d.events.map((e) => (
        <div key={e.id} className={cx("event", !e.programming.length && "bare")}>
          <div className="event-head"><b>{e.name}</b><span className="dim mono small">#{e.id}</span>
            <span className="spread dim small">{e.programming.length ? `${e.programming.length} lines` : "no programming"}</span></div>
          {!!e.programming.length && <div className="code">{e.programming.map((l) => <CodeRow key={l.id} line={l} />)}</div>}
        </div>
      ))}
    </div>
  );
}
