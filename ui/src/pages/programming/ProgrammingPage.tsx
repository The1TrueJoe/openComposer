/** Composer's Programming view, modernised. Left, Device Events: the project tree and the
 *  selected item's events (or every event that has programming). Centre: the open event's
 *  script. Right, Actions: commands, conditionals, loops, variables and Composer's controls
 *  (Else, Delay, Stop, Break, comments) to add to it. Every change is an op (`add_code`,
 *  `add_conditional`, `move_code`, `set_code_enabled`…) through the approval card; read-only
 *  Directors can be read, not changed.
 *
 *  Lines inside a new If go in once Director has given it an id, so an If and its contents are
 *  two approvals. Not here: compound conditions (AND/OR) and editing a line in place. */

import { ArrowLeft, Info, Lock, Search, Trash2, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CodeLineView, type CommandParam, type Op, type ProgrammingEvent, type ShortItem, type TreeNode } from "../../api";
import { Tabs } from "../../components/controls";
import { CodeRow } from "../../components/DiffView";
import { Tip } from "../../components/Dialogs";
import { DriverIcon, KindIcon } from "../../components/icons";
import { BottomPane, Grip, MainPane, Panes, SidePane } from "../../components/Panes";
import { Failure, Loading, ReadOnlyLock } from "../../components/shell";
import type { Available } from "../../lib/control";
import type { ProgramFocus, Shell } from "../../lib/shell";
import { cx, plural, useLoad } from "../../lib/ui";
import { ProjectTree } from "../design/ProjectTree";
import { Actions } from "./Actions";
import { displayFor, elseSlot, nestedUnder, nodeIndex, roleOf, slotFrom, slotProblem, slotWhere, withName, type Place, type Slot } from "./code";
import { draftLabel, LineDialog, ready, type Draft, type LineSpec } from "./Lines";
import { ParamsDialog } from "./Params";
import { Script } from "./Script";

type Mode = "devices" | "programmed";
/** An open event: `owner` is the item that fires it (a proxy, for most devices' events). */
type Ev = { owner: number; event: number };

/** What the page had open, kept across switching tabs (the page unmounts) — per Director. */
const memory: { dir: string | null; mode: Mode; node: number | null; ev: Ev | null; target: number | null; applied: ProgramFocus | null } = {
  dir: null, mode: "devices", node: null, ev: null, target: null, applied: null,
};

const sameEv = (a: Ev | null, b: Ev | null) => !!a && !!b && a.owner === b.owner && a.event === b.event;

export function ProgrammingPage({ shell }: { shell: Shell }) {
  const dir = shell.director?.id ?? null;
  if (memory.dir !== dir) Object.assign(memory, { dir, mode: "devices", node: null, ev: null, target: null });

  const treeRes = useLoad(() => api.tree(), [shell.rev, dir]);
  const progRes = useLoad(() => api.programming(), [shell.rev, dir]);
  const root = treeRes.data?.tree ?? null;
  const nodes = useMemo(() => nodeIndex(root), [root]);

  const [mode, setMode] = useState<Mode>(memory.mode);
  const [node, setNode] = useState<number | null>(memory.node);
  const [ev, setEv] = useState<Ev | null>(memory.ev);
  const [target, setTarget] = useState<number | null>(memory.target);
  const [line, setLine] = useState<number | null>(null);
  // Where new lines go, in add_code's terms; the marker's row follows from the lines.
  const [place, setPlace] = useState<Place>({ parent: 0, before: 0 });
  const [dragging, setDragging] = useState<Draft | null>(null);
  const [asking, setAsking] = useState<{ a: Available; slot: Slot } | null>(null);
  const [askingLine, setAskingLine] = useState<{ d: Draft; slot: Slot } | null>(null);
  // Why the last thing picked couldn't go where it was meant to.
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { Object.assign(memory, { mode, node, ev, target }); }, [mode, node, ev, target]);

  const open = useCallback((e: Ev, at?: number) => {
    setEv(e);
    if (at != null) setNode(at);
    // Something to pick commands from straight away: the event's own device.
    setTarget((t) => t ?? at ?? e.owner);
  }, []);
  // A different event: nothing selected in it, new lines at its end.
  const evKey = ev ? `${ev.owner}:${ev.event}` : "";
  useEffect(() => { setLine(null); setPlace({ parent: 0, before: 0 }); setNote(null); }, [evKey]);

  // Clicking an event elsewhere (Design › Events) lands here with it open. Each click is a new
  // object, so the same event clicked twice is still honoured; one already applied isn't
  // re-applied when the page remounts.
  useEffect(() => {
    const f = shell.programFocus;
    if (!f || f === memory.applied || !root) return;
    memory.applied = f;
    setMode("devices");
    open({ owner: f.device, event: f.event }, nodes.get(f.device)?.id ?? f.device);
  }, [shell.programFocus, root, nodes, open]);

  const itemRes = useLoad(() => (node == null ? Promise.resolve(null) : api.item(node)), [node, shell.rev, dir]);
  const item = itemRes.data && itemRes.data.id === node ? itemRes.data : null;

  const events = useMemo(() => (item?.events ?? []).map((e) => ({ owner: e.device ?? item!.id, event: e.id, name: e.name, lines: e.programming })), [item]);
  const programmed = progRes.data?.events ?? [];

  const opened = useMemo(() => {
    if (!ev) return null;
    const mine = events.find((e) => sameEv(e, ev));
    if (mine) return { name: mine.name, lines: mine.lines };
    const p = programmed.find((x) => x.device.id === ev.owner && x.event === ev.event);
    if (p) return { name: p.event_name ?? `Event #${p.event}`, lines: p.lines };
    return item ? { name: `Event #${ev.event}`, lines: [] as CodeLineView[] } : null;
  }, [ev, events, programmed, item]);

  const ownerNode = ev ? nodes.get(ev.owner) ?? null : null;
  const ownerName = ownerNode?.name ?? programmed.find((p) => p.device.id === ev?.owner)?.device.name ?? item?.name ?? `#${ev?.owner}`;
  const lines = opened?.lines ?? [];
  const slot = slotFrom(lines, place.parent, place.before);

  const writable = shell.writable;
  const roWhy = writable ? undefined : `${shell.director?.name ?? "This Director"} is read-only: programming can be read here, not changed. Change it in Settings › Directors.`;
  const addWhy = roWhy ?? (ev ? undefined : "Open an event first: pick one under Device Events.");

  const commit = async (a: Available, params: CommandParam[], s: Slot) => {
    if (!ev || !opened) return;
    const display = displayFor(a.def, params);
    const op: Op = { op: "add_code", device: ev.owner, event: ev.event, parent: s.parent, before: s.before, target: a.target, command: a.def.name, params, display };
    await shell.propose([op], `When ${ownerName} › ${opened.name}: ${withName(display, a.targetName)}`);
  };
  /** Any other line, once its values are known: placed at `s` and proposed. */
  const commitLine = async (spec: LineSpec, s: Slot, label: string) => {
    if (!ev || !opened) return;
    const op = { ...spec, device: ev.owner, event: ev.event, parent: s.parent, before: s.before } as Op;
    const o = await shell.propose([op], `When ${ownerName} › ${opened.name}: add ${label}`);
    if (o?.status === "applied") setNote(null);
  };
  const add = (d: Draft, at: Slot = slot) => {
    if (!writable || !ev) return;
    let s = at;
    if (d.kind === "else" && slotProblem(lines, s, "else")) {
      // Not where an Else can go: the selected If (or the one just above the marker) takes it.
      const sel = lines.findIndex((l) => l.id === line);
      const above = [...lines.slice(0, s.index).keys()].reverse().find((k) => elseSlot(lines, k));
      const k = sel >= 0 && elseSlot(lines, sel) ? sel : above;
      const es = k != null ? elseSlot(lines, k) : null;
      if (!es) { setNote(slotProblem(lines, s, "else")); return; }
      s = es;
    } else {
      const p = slotProblem(lines, s);
      if (p) { setNote(p); return; }
    }
    setNote(null);
    if (d.kind === "command") {
      if (d.a.def.params.length) setAsking({ a: d.a, slot: s });
      else void commit(d.a, [], s);
      return;
    }
    const spec = ready(d);
    if (spec) void commitLine(spec, s, draftLabel(d));
    else setAskingLine({ d, slot: s });
  };
  const remove = async (i: number) => {
    const l = lines[i];
    if (!l || !ev || !opened || !writable) return;
    const n = nestedUnder(lines, i);
    const withElse = roleOf(l) === "if" && n > 0 ? " (and its Else, if it has one)" : "";
    const o = await shell.propose([{ op: "remove_code", device: ev.owner, event: ev.event, id: l.id }],
      `Remove “${l.text}” from ${ownerName} › ${opened.name}${n ? `, with the ${plural(n, "line")} nested under it${withElse}` : ""}`);
    if (o?.status === "applied") setLine(null);
  };

  // Director moves a line with everything under it (and an If with its Else).
  const move = async (i: number, to: Place) => {
    const l = lines[i];
    if (!l || !ev || !opened || !writable) return;
    const where = to.before ? `above “${lines.find((x) => x.id === to.before)?.text ?? `line #${to.before}`}”`
      : to.parent ? `to the end of “${lines.find((x) => x.id === to.parent)?.text ?? `line #${to.parent}`}”` : "to the end";
    await shell.propose([{ op: "move_code", device: ev.owner, event: ev.event, id: l.id, parent: to.parent, before: to.before }],
      `Move “${l.text}” ${where} in ${ownerName} › ${opened.name}`);
  };
  const toggle = async (i: number) => {
    const l = lines[i];
    if (!l || !ev || !opened || !writable) return;
    await shell.propose([{ op: "set_code_enabled", device: ev.owner, event: ev.event, id: l.id, enabled: !l.enabled }],
      `${l.enabled ? "Disable" : "Enable"} “${l.text}” in ${ownerName} › ${opened.name}`);
  };
  const addElse = (i: number) => {
    const s = elseSlot(lines, i);
    if (s && ev && opened && writable) void commitLine({ op: "add_else" }, s, `an Else to “${lines[i].text}”`);
  };

  if (!root && treeRes.error) return <Failure error={treeRes.error} retry={treeRes.reload} />;

  const where = ev && opened ? `${ownerName} › ${opened.name}, ${slotWhere(lines, slot)}` : "";
  const selIndex = lines.findIndex((l) => l.id === line);

  return (
    <Panes id="programming-editor">
      <SidePane id="device-events" side="left" title="Device Events" defaultSize={270}>
        <Tabs className="detail-tabs prog-tabs" value={mode} onChange={setMode}
              tabs={[{ id: "devices", label: "Devices" }, { id: "programmed", label: <>Programmed <span className="n">{programmed.length}</span></> }]} />
        {mode === "devices" ? (
          <div className="prog-fill">
            <Panes id="programming-events" orientation="vertical">
              <MainPane id="event-tree" minSize={110}>
                <div className="prog-stack">
                  {root ? <ProjectTree root={root} sel={node} onSelect={setNode} onMenu={(e) => e.preventDefault()} onControl={setNode} />
                    : <Loading what="Reading the project" />}
                </div>
              </MainPane>
              <Grip />
              <BottomPane id="event-list" defaultSize="45%" minSize={100}>
                <EventList node={node != null ? nodes.get(node) ?? null : null} name={item?.name} loading={node != null && !item && !itemRes.error}
                           error={itemRes.error} events={events} open={ev} onOpen={(e) => open(e)} />
              </BottomPane>
            </Panes>
          </div>
        ) : (
          <Programmed events={programmed} nodes={nodes} open={ev} loading={!progRes.data}
                      onOpen={(e) => open(e, nodes.get(e.owner)?.id ?? e.owner)} />
        )}
      </SidePane>
      <Grip />
      <MainPane id="script" minSize={380}>
        <div className="panel">
          <div className="crumbs prog-crumbs">
            {ev && opened ? (
              <>
                <Tip text="All programming"><button className="icon-btn" aria-label="All programming" onClick={() => setEv(null)}><ArrowLeft size={14} strokeWidth={1.8} /></button></Tip>
                <span className="prog-crumb"><DriverIcon driver={ownerNode?.driver} kind={ownerNode?.kind ?? "device"} size={14} />{ownerName}</span>
                <span className="sep">›</span>
                <b>{opened.name}</b>
                <span className="grow" />
                <span className="dim small">{plural(lines.length, "line")}</span>
                <Tip text={roWhy ?? (selIndex < 0 ? "Select a line to remove it" : "Remove the selected line (Delete)")}>
                  <span><button className="act small danger" disabled={!writable || selIndex < 0} onClick={() => void remove(selIndex)}>
                    <Trash2 size={12} strokeWidth={1.8} />Remove
                  </button></span>
                </Tip>
              </>
            ) : (
              <>
                <b>All programming</b>
                <span className="grow" />
                <span className="dim small">{plural(programmed.length, "event")} with programming</span>
              </>
            )}
            {!writable && <ReadOnlyLock name={shell.director?.name} />}
          </div>
          {!writable && ev && <div className="prog-ro"><Lock size={12} strokeWidth={1.9} />{roWhy}</div>}
          {note && ev && (
            <div className="prog-ro prog-note" role="status"><Info size={12} strokeWidth={1.9} />{note}
              <button className="icon-btn" aria-label="Dismiss" onClick={() => setNote(null)}><X size={12} strokeWidth={1.9} /></button></div>
          )}
          <div className="panel-body">
            {ev && opened ? (
              <Script owner={ownerNode} ownerName={ownerName} eventName={opened.name} lines={lines} nodes={nodes}
                      selected={line} onSelect={setLine} slot={slot} onSlot={(s) => { setPlace({ parent: s.parent, before: s.before }); setNote(null); }}
                      dragging={dragging ? (dragging.kind === "else" ? "else" : "line") : null} onDrop={(s) => dragging && add(dragging, s)}
                      canWrite={writable} why={roWhy} onDelete={(i) => void remove(i)} onMove={(i, to) => void move(i, to)}
                      onToggle={(i) => void toggle(i)} onAddElse={addElse} />
            ) : ev ? (
              <Loading what="Reading the event" />
            ) : (
              <Overview events={programmed} loading={!progRes.data} error={progRes.error}
                        onOpen={(e) => { setMode("programmed"); open(e, nodes.get(e.owner)?.id ?? e.owner); }} />
            )}
          </div>
        </div>
      </MainPane>
      <Grip />
      <SidePane id="actions" side="right" title="Actions" defaultSize={300}>
        <Actions root={root} target={target} onTarget={setTarget} rev={shell.rev} canAdd={writable && !!opened} why={addWhy}
                 onAdd={(a) => add(a)} onDrag={setDragging} />
      </SidePane>
      <ParamsDialog ask={asking ? { a: asking.a, driver: nodes.get(asking.a.target)?.driver ?? null } : null}
                    where={ev && opened && asking ? `${ownerName} › ${opened.name}, ${slotWhere(lines, asking.slot)}` : where}
                    onCancel={() => setAsking(null)}
                    onAdd={(params) => { const x = asking; setAsking(null); if (x) void commit(x.a, params, x.slot); }} />
      <LineDialog ask={askingLine?.d ?? null}
                  where={ev && opened && askingLine ? `${ownerName} › ${opened.name}, ${slotWhere(lines, askingLine.slot)}` : where}
                  onCancel={() => setAskingLine(null)}
                  onAdd={(spec) => { const x = askingLine; setAskingLine(null); if (x) void commitLine(spec, x.slot, draftLabel(x.d)); }} />
    </Panes>
  );
}

/** The selected item's events, programmed ones marked with how many lines they run. */
function EventList({ node, name, loading, error, events, open, onOpen }: {
  node: TreeNode | null;
  name?: string;
  loading: boolean;
  error?: string;
  events: { owner: number; event: number; name: string; lines: CodeLineView[] }[];
  open: Ev | null;
  onOpen: (e: Ev) => void;
}) {
  return (
    <div className="prog-stack">
      <div className="prog-sub">
        {node && <DriverIcon driver={node.driver} kind={node.kind} size={14} />}
        <span className="prog-sub-name">{node?.name ?? name ?? "Events"}</span>
        <span className="grow" />
        {events.length > 0 && <span className="dim small">{plural(events.length, "event")}</span>}
      </div>
      <div className="panel-body pev-list" role="listbox" aria-label="Events">
        {!node && !name && <p className="hint prog-hint">Pick a device, room or agent above to list its events.</p>}
        {loading && <Loading what="Reading events" />}
        {error && <p className="err small pad">{error}</p>}
        {(node || name) && !loading && !error && !events.length && <p className="hint prog-hint">{node?.name ?? name} fires no events.</p>}
        {events.map((e) => (
          <div key={`${e.owner}:${e.event}`} className={cx("pev", sameEv(open, e) && "sel", e.lines.length > 0 && "has")} role="option"
               aria-selected={sameEv(open, e)} tabIndex={0} onClick={() => onOpen(e)} onKeyDown={(k) => { if (k.key === "Enter") onOpen(e); }}>
            <Zap size={12} strokeWidth={2} className="pev-ic" />
            <span className="pev-name">{e.name}</span>
            {e.lines.length > 0 ? <span className="pev-n" title={plural(e.lines.length, "line")}>{e.lines.length}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Group events with programming by the item that fires them: devices first, then agents, by name. */
function useGroups(events: ProgrammingEvent[], filter: string) {
  return useMemo(() => {
    const q = filter.trim().toLowerCase();
    const by = new Map<number, { device: ShortItem; events: ProgrammingEvent[] }>();
    for (const e of events) {
      const hit = !q || e.device.name.toLowerCase().includes(q) || (e.event_name ?? "").toLowerCase().includes(q)
        || e.lines.some((l) => l.text.toLowerCase().includes(q));
      if (!hit) continue;
      const g = by.get(e.device.id) ?? { device: e.device, events: [] };
      g.events.push(e);
      by.set(e.device.id, g);
    }
    return [...by.values()].sort((a, b) => Number(a.device.kind === "agent") - Number(b.device.kind === "agent") || a.device.name.localeCompare(b.device.name));
  }, [events, filter]);
}

/** Every event that has programming, in the left pane: a way in that skips the tree. */
function Programmed({ events, nodes, open, loading, onOpen }: {
  events: ProgrammingEvent[];
  nodes: Map<number, TreeNode>;
  open: Ev | null;
  loading: boolean;
  onOpen: (e: Ev) => void;
}) {
  const [filter, setFilter] = useState("");
  const groups = useGroups(events, filter);
  return (
    <>
      <div className="search-box">
        <Search size={13} strokeWidth={1.8} />
        <input placeholder="Filter by device, event or line" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="panel-body pev-list">
        {loading && <Loading what="Reading programming" />}
        {!loading && !groups.length && <p className="empty pad">{filter ? `Nothing matches “${filter}”.` : "No programming in this project."}</p>}
        {groups.map((g) => {
          const n = nodes.get(g.device.id);
          return (
            <div key={g.device.id}>
              <div className="pev-owner">
                {n ? <DriverIcon driver={n.driver} kind={n.kind} size={14} /> : <KindIcon kind={g.device.kind ?? "device"} driver={g.device.driver} />}
                <span>{g.device.name}</span>
              </div>
              {g.events.map((e) => {
                const ev = { owner: g.device.id, event: e.event };
                return (
                  <div key={e.event} className={cx("pev has", sameEv(open, ev) && "sel")} tabIndex={0} role="option" aria-selected={sameEv(open, ev)}
                       onClick={() => onOpen(ev)} onKeyDown={(k) => { if (k.key === "Enter") onOpen(ev); }}>
                    <Zap size={12} strokeWidth={2} className="pev-ic" />
                    <span className="pev-name">{e.event_name ?? `Event #${e.event}`}</span>
                    <span className="pev-n">{e.lines.length}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** With no event open: every script in the project, read-only, each a click from being edited. */
function Overview({ events, loading, error, onOpen }: { events: ProgrammingEvent[]; loading: boolean; error?: string; onOpen: (e: Ev) => void }) {
  const groups = useGroups(events, "");
  if (loading) return error ? <Failure error={error} /> : <Loading what="Reading programming" />;
  return (
    <div className="prog">
      {!groups.length && (
        <div className="placeholder">
          <Zap size={20} strokeWidth={1.6} />
          <p>No programming in this project yet. Pick an event under Device Events to start.</p>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.device.id} className="prog-group">
          <h3 className="h"><KindIcon kind={g.device.kind ?? "device"} driver={g.device.driver} />{g.device.name}
            <span className="dim small">{plural(g.events.length, "event")}</span></h3>
          {g.events.map((e) => {
            const off = e.lines.filter((l) => !l.enabled).length;
            return (
              <div key={e.event} className="event prog-card">
                <button className="event-head prog-open" onClick={() => onOpen({ owner: g.device.id, event: e.event })} title="Open this event">
                  <Zap size={12} strokeWidth={2} className="accent" />
                  <b>{e.event_name ?? `Event #${e.event}`}</b>
                  <span className="spread dim small">{plural(e.lines.length, "line")}{off ? `, ${off} disabled` : ""}</span>
                  <span className="prog-open-go small">Open</span>
                </button>
                <div className="code">{e.lines.map((l) => <CodeRow key={l.id} line={l} />)}</div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
