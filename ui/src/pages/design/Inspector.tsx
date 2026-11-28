import { AppWindow, FolderInput, SquareCode, Gamepad2, Lock, Pencil, Plus, RefreshCw, Trash2, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errText, type AgentView, type ItemDetail, type KindLabel, type PropertyView } from "../../api";
import { CodeRow } from "../../components/DiffView";
import { Tip, useDialog } from "../../components/Dialogs";
import { Select, Spinner, Tabs } from "../../components/controls";
import { DriverIcon } from "../../components/icons";
import { Failure, Loading } from "../../components/shell";
import type { InspectorTab, Shell } from "../../lib/shell";
import { cx, useLoad } from "../../lib/ui";
import { Connections } from "./Connections";
import { AgentPanel, type NativeAgentView } from "./agents/AgentPanel";

export interface ItemActions {
  rename: (id: number, name: string) => void;
  remove: (id: number, name: string, kind: KindLabel) => void;
  move: (id: number, name: string, kind: KindLabel) => void;
  addRoom: (floor: number) => void;
  addDevice: (room: number) => void;
  /** Open the device control panel. */
  control: (id: number) => void;
}

const TABS: { id: InspectorTab; label: string }[] = [
  { id: "properties", label: "Properties" },
  { id: "connections", label: "Connections" },
  { id: "network", label: "Network" },
  { id: "variables", label: "Variables" },
  { id: "events", label: "Events" },
];

/** Everything about one item, the way Composer's properties pane shows it. */
export function Inspector({ id, shell, onSelect, actions }: {
  id: number; shell: Shell; onSelect: (id: number) => void; actions: ItemActions;
}) {
  const item = useLoad(() => api.item(id), [id, shell.rev]);
  // The driver's own web pages (driver.xml <tabs>). Most drivers have none; one that can't be
  // asked (no web API) just shows none rather than an error on every selection.
  const web = useLoad(() => api.driverTabs(id).then((r) => ({ id, tabs: r.tabs }), () => ({ id, tabs: [] as { name: string; url: string }[] })), [id]);
  // The app holds the built-in tab: an assistant can switch it, and it says which one you're
  // looking at. A web tab is local: it means nothing to anyone else.
  const { inspectorTab: tab, setInspectorTab: setTab } = shell;
  const [webTab, setWebTab] = useState<string | null>(null);
  // Web tabs once opened stay loaded (hidden) so switching back doesn't reload the page.
  const [visited, setVisited] = useState<string[]>([]);
  useEffect(() => { setWebTab(null); setVisited([]); setAgentOn(false); }, [id]);
  // Built-in agents Composer edits with its own plugin (Scheduler, Advanced Lighting…) get
  // that editor as their first tab, like a driver's web pages.
  const isAgent = item.data?.id === id && item.data.kind === "agent";
  const native = useLoad<{ id: number; v: AgentView | null; error: string | null }>(
    () => (isAgent ? api.agentView(id).then((v) => ({ id, v, error: null }), (e) => ({ id, v: null, error: errText(e) })) : Promise.resolve({ id, v: null, error: null })),
    [id, isAgent, shell.rev],
  );
  const [agentOn, setAgentOn] = useState(false);
  const nv = native.data?.id === id && native.data.v?.view ? (native.data.v as NativeAgentView) : null;
  const nativeError = native.data?.id === id ? native.data.error : null;
  const hasNative = !!nv || !!nativeError;
  const d = item.data?.id === id ? item.data : undefined;
  const webTabs = web.data?.id === id ? web.data.tabs : [];
  const open = (name: string) => {
    setAgentOn(false);
    setWebTab(name);
    setVisited((v) => (v.includes(name) ? v : [...v, name]));
  };
  // A driver's own pages are what it wants you to see first; open the first one unless you
  // had picked a specific built-in tab.
  useEffect(() => {
    if (webTabs.length && tab === "properties" && !agentOn) open(webTabs[0].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [web.data]);
  useEffect(() => {
    if (hasNative && tab === "properties" && !webTab) setAgentOn(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native.data?.id, hasNative]);

  if (!d) return item.error ? <Failure error={item.error} retry={item.reload} /> : <Loading what="Reading the item" />;

  const w = shell.writable;
  const why = w ? undefined : `${shell.director?.name ?? "This Director"} is read-only`;
  const controllable = d.kind === "device" || d.kind === "proxy" || d.kind === "room";
  // Only the tabs that mean something for this item: a driver with no connections (or that
  // isn't on the network) has nothing to show there.
  const has: Record<InspectorTab, boolean> = {
    properties: true,
    connections: d.connections.length > 0 || d.children.some((c) => c.connections.length > 0),
    network: d.network.length > 0 || d.network_connections.length > 0 || !!d.device?.search_type,
    variables: true,
    events: true,
  };
  const shown = has[tab] ? tab : "properties";

  return (
    <div className="panel insp">
      <div className="insp-head">
        <span className="insp-ic"><DriverIcon driver={d.driver} kind={d.kind} proxy={d.device?.proxies[0] ?? (d.kind === "proxy" ? d.driver?.replace(/\.c4[iz]$/i, "") : null)} size={22} /></span>
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
          {controllable && (
            <Tip text={w ? (d.kind === "room" ? "What to watch and listen to, volume and room off (or double-click the room in the tree)" : "Live state and commands (or double-click it in the tree)") : `${why}: you can watch its state, not send commands`}>
              <span><button className="act small" onClick={() => actions.control(d.id)}><Gamepad2 size={14} strokeWidth={1.8} />Control</button></span>
            </Tip>
          )}
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
      <Tabs<string> tabs={[
              ...(hasNative ? [{ id: "agent:", label: <>{nv?.title ?? d.name}</> }] : []),
              ...webTabs.map((t) => ({ id: `web:${t.name}`, label: <><AppWindow size={12} strokeWidth={1.8} />{t.name}</> })),
              ...TABS.filter((t) => has[t.id]),
            ]}
            value={agentOn && hasNative ? "agent:" : webTab ? `web:${webTab}` : shown}
            onChange={(t) => {
              if (t === "agent:") {
                setWebTab(null);
                setAgentOn(true);
              } else if (t.startsWith("web:")) {
                open(t.slice(4));
              } else {
                setWebTab(null);
                setAgentOn(false);
                setTab(t as InspectorTab);
              }
            }} />
      {/* An agent's own tab lays out its table and detail itself, like a web tab or Connections. */}
      <div className={cx("panel-body", ((agentOn && hasNative) || webTab || shown === "connections") && "fill")}>
        {agentOn && nv && <AgentPanel v={nv} shell={shell} onSelect={onSelect} reload={native.reload} />}
        {agentOn && !nv && nativeError && <Failure error={nativeError} retry={native.reload} />}
        {!webTab && !(agentOn && hasNative) && shown === "properties" && <Properties d={d} shell={shell} />}
        {!webTab && !(agentOn && hasNative) && shown === "connections" && <Connections d={d} shell={shell} onSelect={onSelect} />}
        {!webTab && !(agentOn && hasNative) && shown === "network" && <Network d={d} shell={shell} />}
        {!webTab && !(agentOn && hasNative) && shown === "variables" && <Variables d={d} />}
        {!webTab && !(agentOn && hasNative) && shown === "events" && <Events d={d} shell={shell} />}
        {webTabs.filter((t) => visited.includes(t.name)).map((t) => (
          <WebTab key={`${d.id}:${t.name}`} name={t.name} url={t.url} shown={webTab === t.name} />
        ))}
      </div>
    </div>
  );
}

/** A driver's own page, the way Composer hosts it: full size, its scripts and websockets
 *  allowed (openComposer serves it on 127.0.0.1 and proxies its calls to the controller). */
function WebTab({ name, url, shown }: { name: string; url: string; shown: boolean }) {
  const [state, setState] = useState<"checking" | "loading" | "ready" | "error">("checking");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let gone = false;
    setState("checking");
    // A frame can't say it failed; ask first whether anything answers at that address.
    const probe = /^https?:/i.test(url) ? fetch(url, { mode: "no-cors", cache: "no-store" }) : Promise.resolve();
    probe.then(() => { if (!gone) setState("loading"); }, (e) => {
      if (gone) return;
      setError(`Nothing answered at the page's address (${e instanceof Error ? e.message : String(e)}).`);
      setState("error");
    });
    return () => { gone = true; };
  }, [url, attempt]);
  useEffect(() => {
    if (state !== "loading") return;
    const t = setTimeout(() => { setError("The page didn't finish loading within 20 seconds."); setState("error"); }, 20_000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <div className="webtab" hidden={!shown}>
      {state === "error" ? (
        <div className="placeholder">
          <AppWindow size={22} strokeWidth={1.5} />
          <p><b>“{name}” couldn't be shown.</b> {error} The driver's page is served by openComposer from the driver package, through the controller's web API — check that the web API is on for this Director.</p>
          <div className="row">
            <button className="act" onClick={() => setAttempt((n) => n + 1)}><RefreshCw size={14} strokeWidth={1.8} />Try again</button>
            {/* The check can be wrong (a webview that refuses the probe but not the frame). */}
            <button className="act quiet" onClick={() => setState("loading")}>Show it anyway</button>
          </div>
        </div>
      ) : (
        <>
          {state !== "ready" && <div className="loading webtab-wait"><Spinner size="lg" /><span>Loading “{name}”…</span></div>}
          {state !== "checking" && (
            <iframe key={attempt} title={name} src={url} className={cx(state === "ready" && "ready")}
                    allow="clipboard-read; clipboard-write; fullscreen; autoplay" onLoad={() => setState("ready")} />
          )}
        </>
      )}
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
            {d.actions.map((a) => (
              <button key={a.command} className="act small" title={a.command} disabled={!shell.writable}
                onClick={() => shell.propose([{ op: "run_action", device: d.id, command: a.command }], `Run “${a.name}”`)}>
                {a.name}
              </button>
            ))}
          </div>
          <p className="hint">Actions run on the device itself, so each one is approved like a change.</p>
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
            <td>{n.status ? <span className={cx("tag", n.status === "online" ? "on" : "warn")}>{n.status}</span> : "—"}</td>
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
          <tr key={`${v.device}:${v.id}`} className={cx(v.hidden && "dimmed")}>
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

/** The driver's events; each opens in Programming, where it can be programmed. */
function Events({ d, shell }: { d: ItemDetail; shell: Shell }) {
  if (!d.events.length) return <p className="empty pad">This driver declares no events.</p>;
  return (
    <div className="events">
      {d.events.map((e) => (
        <div key={`${e.device ?? d.id}:${e.id}`} className={cx("event link-event", !e.programming.length && "bare")} role="button" tabIndex={0}
             title="Program this event" onClick={() => shell.program({ device: e.device ?? d.id, event: e.id })}
             onKeyDown={(k) => { if (k.key === "Enter") shell.program({ device: e.device ?? d.id, event: e.id }); }}>
          <div className="event-head"><b>{e.name}</b><span className="dim mono small">#{e.id}</span>
            <span className="spread dim small">{e.programming.length ? `${e.programming.length} lines` : "no programming"}</span>
            <SquareCode size={13} strokeWidth={1.8} className="event-go" /></div>
          {!!e.programming.length && <div className="code">{e.programming.map((l) => <CodeRow key={l.id} line={l} />)}</div>}
        </div>
      ))}
    </div>
  );
}
