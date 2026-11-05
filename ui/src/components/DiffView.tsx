import {
  ArrowRight, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, EyeOff, MapPin, Network, Package, Plug, Sparkles, User,
} from "lucide-react";
import { Fragment, memo, useMemo, useState } from "react";
import type { Change, CodeLine, ConnectionDef, Diff, Endpoint, ItemDetail, ItemRef, PropertyView } from "../api";
import { effectOf, groupByLocation, inlineDiff, isCascade, subjectOf, tally, type Effect, type LocGroup, type Seg } from "../lib/diff";
import { ago, cx, dateTime, plural } from "../lib/ui";
import { DiffGraph } from "./DiffGraph";
import { Spinner } from "./controls";
import { KindIcon } from "./icons";
import { Tip } from "./Dialogs";

/** Fetches a device's current detail, for showing unchanged settings around a change as context.
 *  The caller supplies it only when the diff is against the live director (an approval card). */
export type FetchItem = (id: number) => Promise<ItemDetail | null>;

export interface DiffHeader {
  source?: string;
  director?: string;
  project?: string;
  reason?: string | null;
  time?: string;
  /** One line per op, in the project's own names. */
  descriptions?: string[];
  /** Driver files being put on the controller: not a project change, so not in the diff. */
  installs?: { filename: string; source: string }[];
}

/** Rows drawn per section before "show more". Each page is cheap; thousands at once are not,
 *  and a project compare can produce thousands. */
const PAGE = 80;
/** Sections bigger than this start collapsed, so a huge compare opens on its summary. */
const COLLAPSE_OVER = 120;

/** A semantic project diff, in Composer's terms: what is added, removed and changed among
 *  rooms and devices, properties, connections, network identities, variables and programming.
 *  The same view on an approval card, inline in the agent chat, and comparing backups. */
export function DiffView({ diff, header, graph = true, empty = "No differences.", fetchItem }: {
  diff: Diff;
  header?: DiffHeader;
  /** The affected-devices map above the sections (off for nested side-effect diffs). */
  graph?: boolean;
  empty?: string;
  /** When given (a live approval), a changed device can expand to show its other settings as
   *  context, the way git shows the lines around a change. */
  fetchItem?: FetchItem;
}) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? diff.changes.filter((c) => searchText(c).includes(q)) : diff.changes;
  }, [diff.changes, filter]);
  const groups = useMemo(() => groupByLocation(shown), [shown]);
  const [closed, setClosed] = useState<Set<string>>(
    () => new Set(groupByLocation(diff.changes).filter((g) => g.changes.length > COLLAPSE_OVER).map((g) => g.key)));
  // The device map is a secondary, optional view — collapsed by default so the diff opens on
  // the changes themselves, not a diagram competing for attention.
  const [showGraph, setShowGraph] = useState(false);
  // Recount rather than trust `summary`: verification side effects arrive with it zeroed.
  const t = useMemo(() => tally(diff.changes), [diff.changes]);
  const hasConnections = diff.changes.some((c) => c.kind === "connection_added" || c.kind === "connection_removed");

  return (
    <div className="dv">
      {header && <DiffHead header={header} />}
      <div className="dv-bar">
        <span className="dv-chip added" title="added">+{t.added}</span>
        <span className="dv-chip removed" title="removed">−{t.removed}</span>
        <span className="dv-chip changed" title="changed">~{t.changed}</span>
        <span className="dv-total">{plural(diff.changes.length, "change")}</span>
        <span className="grow" />
        {diff.changes.length > 12 && (
          <input className="dv-filter" placeholder="Filter changes…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
        {graph && hasConnections && (
          <Tip text={showGraph ? "Hide the device map" : "Show the device map"}>
            <button className={cx("icon-btn", showGraph && "on")} onClick={() => setShowGraph(!showGraph)} aria-label="Device map">
              <Network size={14} strokeWidth={1.8} />
            </button>
          </Tip>
        )}
        {groups.length > 1 && (
          <Tip text={closed.size ? "Expand all" : "Collapse all"}>
            <button className="icon-btn" aria-label={closed.size ? "Expand all" : "Collapse all"}
                    onClick={() => setClosed(closed.size ? new Set() : new Set(groups.map((g) => g.key)))}>
              {closed.size ? <ChevronsUpDown size={14} strokeWidth={1.8} /> : <ChevronsDownUp size={14} strokeWidth={1.8} />}
            </button>
          </Tip>
        )}
      </div>
      {graph && hasConnections && showGraph && <DiffGraph changes={diff.changes} />}
      {!diff.changes.length && <p className="empty dv-empty">{empty}</p>}
      {!!diff.changes.length && !shown.length && <p className="empty dv-empty">No change matches “{filter}”.</p>}
      {groups.map((g) => (
        <LocationGroup key={g.key} group={g} open={!closed.has(g.key)} fetchItem={fetchItem}
                 onToggle={() => setClosed((c) => { const n = new Set(c); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })} />
      ))}
    </div>
  );
}

function DiffHead({ header: h }: { header: DiffHeader }) {
  return (
    <div className="dv-head">
      <div className="dv-meta">
        {h.source && <SourceBadge source={h.source} />}
        {h.director && <span>{h.director}</span>}
        {h.project && <span className="dim">· {h.project}</span>}
        {h.time && <span className="dim spread" title={dateTime(h.time)}>{ago(h.time)}</span>}
      </div>
      {h.reason && <blockquote className="dv-reason">{h.reason}</blockquote>}
      {!!h.descriptions?.length && (
        <ol className="dv-ops">{h.descriptions.map((d, i) => <li key={i}>{d}</li>)}</ol>
      )}
      {h.installs?.map((x) => (
        <div key={x.filename} className="dv-install">
          <Package size={14} strokeWidth={1.8} />
          <span>Installs driver file <code>{x.filename}</code></span>
          <span className="dim">from {x.source}</span>
        </div>
      ))}
    </div>
  );
}

export function SourceBadge({ source }: { source: string }) {
  const Icon = source.startsWith("You") ? User : source === "In-app agent" ? Sparkles : Plug;
  const label = source.startsWith("You") ? "You" : source;
  return <span className="source-badge"><Icon size={12} strokeWidth={1.8} />{label}</span>;
}

/** One location's changes, under a header that names the place once — like a git file header,
 *  so the path isn't repeated on every row. Property changes stay grouped under their device. */
function LocationGroup({ group: g, open, onToggle, fetchItem }: { group: LocGroup; open: boolean; onToggle: () => void; fetchItem?: FetchItem }) {
  const [limit, setLimit] = useState(PAGE);
  const t = tally(g.changes);
  const visible = g.changes.slice(0, limit);
  const props = visible.filter((c): c is Extract<Change, { kind: "property_changed" }> => c.kind === "property_changed");
  const rest = visible.filter((c) => c.kind !== "property_changed");
  return (
    <section className={cx("dv-sec", `dv-loc-${g.kind}`)}>
      <button className="dv-sec-head" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={13} strokeWidth={1.8} /> : <ChevronRight size={13} strokeWidth={1.8} />}
        <LocHeader group={g} />
        <span className="dv-count">{g.changes.length}</span>
        <span className="dv-mini">
          {!!t.added && <span className="added">+{t.added}</span>}
          {!!t.removed && <span className="removed">−{t.removed}</span>}
          {!!t.changed && <span className="changed">~{t.changed}</span>}
        </span>
      </button>
      {open && (
        <div className="dv-rows">
          {rest.map((c, i) => <Row key={i} change={c} hideCrumbs fetchItem={fetchItem} />)}
          {props.length > 0 && <PropertyRows changes={props} hideCrumbs fetchItem={fetchItem} />}
          {g.changes.length > limit && (
            <button className="dv-more" onClick={() => setLimit(limit + PAGE * 4)}>
              Show {Math.min(PAGE * 4, g.changes.length - limit)} more of {g.changes.length - limit} remaining
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** The group header: the location path as quiet breadcrumbs (a git-style "file" line), or a plain
 *  label for the Connections / Project groups. */
function LocHeader({ group: g }: { group: LocGroup }) {
  if (g.kind !== "location") return <span className="dv-loc-title">{g.path[0]}</span>;
  return (
    <span className="dv-loc-title">
      <MapPin size={12} strokeWidth={1.8} className="dv-loc-ic" />
      {g.path.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="sep">›</span>}
          <span className={cx(i === g.path.length - 1 && "dv-loc-leaf")}>{p}</span>
        </Fragment>
      ))}
    </span>
  );
}

// ---- rows ----------------------------------------------------------------------------------

const Gutter = ({ effect }: { effect: Effect }) => (
  <span className={cx("dv-gutter", effect)} aria-label={effect}>{effect === "added" ? "+" : effect === "removed" ? "−" : "~"}</span>
);

function Crumbs({ parts, diffWith }: { parts: string[]; diffWith?: string[] }) {
  if (!parts.length) return null;
  return (
    <span className="dv-crumbs">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="sep">›</span>}
          <span className={cx(diffWith && diffWith[i] !== p && "hl")}>{p}</span>
        </Fragment>
      ))}
    </span>
  );
}

function Name({ item, driver, strike }: { item: ItemRef; driver?: string | null; strike?: boolean }) {
  return (
    <span className="dv-name">
      <span className="dv-ic"><KindIcon kind={item.item_kind} driver={driver} /></span>
      <b className={cx(strike && "strike")}>{item.name}</b>
    </span>
  );
}

/** A value changing, with the part that changed lit up on each side. */
export function ValueChange({ from, to }: { from: string | null; to: string | null }) {
  const masked = (from ?? "").startsWith("••") && (to ?? "").startsWith("••");
  if (masked) return <span className="dv-masked"><EyeOff size={12} strokeWidth={1.8} /> hidden value changed</span>;
  const d = inlineDiff(from ?? "", to ?? "");
  return (
    <span className="dv-change">
      <span className="dv-from">{from == null ? <i className="dim">unset</i> : from === "" ? <i className="dim">empty</i> : <Segs segs={d.from} />}</span>
      <ArrowRight size={12} strokeWidth={1.8} className="dv-arrow" />
      <span className="dv-to">{to == null ? <i className="dim">unset</i> : to === "" ? <i className="dim">empty</i> : <Segs segs={d.to} />}</span>
    </span>
  );
}

const Segs = ({ segs }: { segs: Seg[] }) => <>{segs.map((s, i) => s.changed ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>)}</>;

const Row = memo(function Row({ change: c, hideCrumbs, fetchItem }: { change: Change; hideCrumbs?: boolean; fetchItem?: FetchItem }) {
  const effect = effectOf(c);
  const cls = cx("dv-row", effect, isCascade(c) && "cascade");
  switch (c.kind) {
    case "item_added":
    case "item_removed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Name item={c.item} driver={c.driver} strike={c.kind === "item_removed"} />
          <span className="tag">{typeof c.item.item_kind === "string" ? c.item.item_kind : "item"}</span>
          {c.descendants > 0 && <span className="tag">+{c.descendants} inside</span>}
          {!hideCrumbs && <Crumbs parts={c.item.location} />}
          {c.driver && <code className="dv-driver">{c.driver}</code>}
        </div>
      );
    case "item_renamed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <span className="dv-name"><span className="dv-ic"><KindIcon kind={c.item.item_kind} /></span></span>
          <ValueChange from={c.from} to={c.to} />
          <span className="tag">renamed</span>
          {!hideCrumbs && <Crumbs parts={c.item.location} />}
        </div>
      );
    case "item_moved":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Name item={c.item} />
          <span className="tag">moved</span>
          <span className="dv-change">
            <span className="dv-from"><Crumbs parts={c.from} diffWith={c.to} /></span>
            <ArrowRight size={12} strokeWidth={1.8} className="dv-arrow" />
            <span className="dv-to"><Crumbs parts={c.to} diffWith={c.from} /></span>
          </span>
        </div>
      );
    case "driver_changed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Name item={c.item} driver={c.to} />
          <span className="tag">driver</span>
          <ValueChange from={c.from} to={c.to} />
          {!hideCrumbs && <Crumbs parts={c.item.location} />}
        </div>
      );
    case "connection_added":
    case "connection_removed":
      return (
        <>
          <div className={cls}>
            <Gutter effect={effect} />
            <Wire provider={c.connection.provider} consumer={c.connection.consumer} classes={c.connection.classes} effect={effect} />
            {c.kind === "connection_removed" && c.cascade && <span className="tag warn">removed with device</span>}
          </div>
          {fetchItem && <ConnectionContext endpoints={[c.connection.provider.device, c.connection.consumer.device]} fetchItem={fetchItem} />}
        </>
      );
    case "network_added":
    case "network_removed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Name item={c.item} strike={c.kind === "network_removed"} />
          <span className="dv-net">
            {c.kind === "network_added" ? "identified as" : "no longer identified as"} <code>{c.search_type || addressType(c.address_type)}</code>
            {" at "}<code>{c.address}</code>
            <span className="dim"> · binding {c.binding} · {addressType(c.address_type)}</span>
          </span>
          {c.kind === "network_removed" && c.cascade && <span className="tag warn">removed with device</span>}
        </div>
      );
    case "network_changed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Name item={c.item} />
          <span className="dv-prop">{c.field}</span>
          <ValueChange from={c.from} to={c.to} />
          <span className="dim small">binding {c.binding}</span>
        </div>
      );
    case "variable_added":
    case "variable_removed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Name item={c.owner} />
          <code className={cx("dv-var", c.kind === "variable_removed" && "strike")}>{c.name}</code>
          {c.value !== "" && <span className="dim">= <span className="mono">{c.value}</span></span>}
          {c.kind === "variable_removed" && c.cascade && <span className="tag warn">removed with device</span>}
        </div>
      );
    case "variable_changed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Name item={c.owner} />
          <code className="dv-var">{c.name}</code>
          <span className="dv-prop">{c.field}</span>
          <ValueChange from={c.from} to={c.to} />
        </div>
      );
    case "programming_changed":
      return <CodeDiff owner={c.owner} event={c.event_name ?? `Event #${c.event}`} lines={c.lines} />;
    case "schedule_added":
    case "schedule_removed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Name item={c.owner} />
          <span className={cx("dv-prop", c.kind === "schedule_removed" && "strike")}>{c.name}</span>
          <span className="dim">{c.when}</span>
          {c.kind === "schedule_removed" && c.cascade && <span className="tag warn">removed with agent</span>}
        </div>
      );
    case "schedule_changed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Name item={c.owner} />
          <span className="dv-prop">{c.name} · {c.field}</span>
          <ValueChange from={c.from} to={c.to} />
        </div>
      );
    case "agent_record_added":
    case "agent_record_removed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Name item={c.owner} />
          <span className="dim">{c.what}</span>
          <span className={cx("dv-prop", c.kind === "agent_record_removed" && "strike")}>{c.name}</span>
          {c.kind === "agent_record_removed" && c.cascade && <span className="tag warn">removed with agent</span>}
          {c.kind === "agent_record_added" && !!c.details.length && (
            <span className="dv-details dim">{c.details.filter(([, v]) => v !== "none").map(([k, v]) => `${k}: ${v}`).join(" · ")}</span>
          )}
        </div>
      );
    case "agent_record_changed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Name item={c.owner} />
          <span className="dv-prop">{c.name} · {c.field}</span>
          <ValueChange from={c.from === "none" ? null : c.from} to={c.to === "none" ? null : c.to} />
        </div>
      );
    case "property_changed":
      return null; // drawn by PropertyRows, grouped under their item
  }
});

/** Properties grouped under their item: ten changed properties of one driver read as one
 *  device being reconfigured, not ten unrelated things. */
function PropertyRows({ changes, hideCrumbs, fetchItem }: { changes: Change[]; hideCrumbs?: boolean; fetchItem?: FetchItem }) {
  const groups = useMemo(() => {
    const out: { item: ItemRef; rows: Extract<Change, { kind: "property_changed" }>[] }[] = [];
    for (const c of changes) {
      if (c.kind !== "property_changed") continue;
      const last = out[out.length - 1];
      if (last && last.item.id === c.item.id && last.item.name === c.item.name) last.rows.push(c);
      else out.push({ item: c.item, rows: [c] });
    }
    return out;
  }, [changes]);
  return (
    <>
      {groups.map((g, i) => (
        <div key={i} className="dv-pgroup">
          <div className="dv-pitem"><Name item={g.item} />{!hideCrumbs && <Crumbs parts={g.item.location} />}</div>
          {g.rows.map((c, j) => (
            <div key={j} className={cx("dv-row changed", c.from == null && "added", c.to == null && "removed")}>
              <Gutter effect={c.from == null ? "added" : c.to == null ? "removed" : "changed"} />
              <span className="dv-prop">{c.property}</span>
              <ValueChange from={c.from} to={c.to} />
            </div>
          ))}
          {fetchItem && <PropertyContext itemId={g.item.id} changed={new Set(g.rows.map((r) => r.property))} fetchItem={fetchItem} />}
        </div>
      ))}
    </>
  );
}

/** The device's other settings, shown on demand as dimmed context rows — the way git shows the
 *  unchanged lines around a change, so a change reads against the device's whole configuration. */
function PropertyContext({ itemId, changed, fetchItem }: { itemId: number; changed: Set<string>; fetchItem: FetchItem }) {
  const [open, setOpen] = useState(false);
  const [props, setProps] = useState<PropertyView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (props || loading) return;
    setLoading(true);
    try {
      const d = await fetchItem(itemId);
      setProps(d?.properties ?? []);
    } catch {
      setProps([]);
    } finally {
      setLoading(false);
    }
  };
  // Settings that didn't change (and aren't blank) are the useful context.
  const context = (props ?? []).filter((p) => !changed.has(p.name) && p.value !== "");
  return (
    <>
      <button className="dv-context-toggle" onClick={toggle} aria-expanded={open}>
        {open ? <ChevronDown size={11} strokeWidth={1.8} /> : <ChevronRight size={11} strokeWidth={1.8} />}
        {open ? "Hide" : "Show"} the device's other settings
      </button>
      {open && (loading
        ? <div className="dv-row context"><span className="dv-prop dim"><Spinner /> reading settings…</span></div>
        : !context.length
          ? <div className="dv-row context"><span className="dv-prop dim">No other settings to show.</span></div>
          : context.map((p) => (
            <div key={p.name} className="dv-row context">
              <span className="dv-gutter context"> </span>
              <span className="dv-prop">{p.name}</span>
              <span className="dv-ctx-val">{p.value}</span>
            </div>
          )))}
    </>
  );
}

/** The other wiring on the devices a changed connection touches — shown on demand as dimmed
 *  context, so a change reads against what's already plugged into each device. */
function ConnectionContext({ endpoints, fetchItem }: { endpoints: ItemRef[]; fetchItem: FetchItem }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ id: number; name: string; conns: ConnectionDef[] }[] | null>(null);
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (data || loading) return;
    setLoading(true);
    try {
      const uniq = endpoints.filter((e, i) => endpoints.findIndex((x) => x.id === e.id) === i);
      const out = await Promise.all(uniq.map(async (e) => {
        const d = await fetchItem(e.id);
        return { id: e.id, name: e.name, conns: (d?.connections ?? []).filter((c) => c.connected_to.length) };
      }));
      setData(out);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <button className="dv-context-toggle" onClick={toggle} aria-expanded={open}>
        {open ? <ChevronDown size={11} strokeWidth={1.8} /> : <ChevronRight size={11} strokeWidth={1.8} />}
        {open ? "Hide" : "Show"} these devices' other connections
      </button>
      {open && (loading
        ? <div className="dv-row context"><span className="dv-prop dim"><Spinner /> reading connections…</span></div>
        : (data ?? []).map((dev) => (
          dev.conns.length === 0
            ? <div key={dev.id} className="dv-row context"><span className="dv-ctx-conn dim">{dev.name} — no other connections</span></div>
            : <Fragment key={dev.id}>{dev.conns.map((c) => (
                <div key={c.id} className="dv-row context">
                  <span className="dv-gutter context"> </span>
                  <span className="dv-ctx-conn">
                    <b>{dev.name}</b><span className="sep">›</span><span className="dv-port">{c.name}</span>
                    <span className="dv-ctx-arrow">→</span>
                    {c.connected_to.map((p, i) => (
                      <Fragment key={i}>
                        {i > 0 && <span className="dv-ctx-sep">, </span>}
                        <span className="dv-ctx-peer">{p.device.name}{p.connection ? ` › ${p.connection}` : ""}</span>
                      </Fragment>
                    ))}
                  </span>
                </div>
              ))}</Fragment>
        )))}
    </>
  );
}

function End({ e }: { e: Endpoint }) {
  return (
    <span className="dv-end" title={[...e.device.location, e.device.name].join(" › ")}>
      <span className="dv-ic"><KindIcon kind={e.device.item_kind} /></span>
      <b>{e.device.name}</b>
      <span className="sep">›</span>
      <span className="dv-port">{e.connection ?? `#${e.binding}`}</span>
    </span>
  );
}

/** provider › output ──CLASS──▶ consumer › input */
export function Wire({ provider, consumer, classes, effect }: { provider: Endpoint; consumer: Endpoint; classes: string[]; effect: Effect }) {
  return (
    <span className={cx("dv-wire", effect)}>
      <End e={provider} />
      <span className="dv-link"><span className="line" /><span className="cls">{classes.join(" · ")}</span><span className="line" /><span className="head">▶</span></span>
      <End e={consumer} />
    </span>
  );
}

/** Unchanged runs longer than this fold to a "N unchanged lines" bar, keeping this much context. */
const CONTEXT = 2;

function CodeDiff({ owner, event, lines }: { owner: ItemRef; event: string; lines: CodeLine[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const blocks = useMemo(() => foldUnchanged(lines), [lines]);
  const added = lines.filter((l) => l.op === "added").length;
  const removed = lines.filter((l) => l.op === "removed").length;
  return (
    <div className="dv-code">
      <div className="dv-code-head">
        <Name item={owner} />
        <span className="sep">›</span>
        <span className="dv-event">{event}</span>
        <span className="spread dv-mini">
          {!!added && <span className="added">+{added}</span>}
          {!!removed && <span className="removed">−{removed}</span>}
        </span>
      </div>
      <div className="code">
        {blocks.map((b, i) => b.fold && !expanded.has(i) ? (
          <button key={i} className="code-fold" onClick={() => setExpanded(new Set(expanded).add(i))}>
            ⋯ {plural(b.lines.length, "unchanged line")}
          </button>
        ) : b.lines.map((l, j) => <CodeRow key={`${i}-${j}`} line={l} />))}
      </div>
    </div>
  );
}

export function CodeRow({ line: l }: { line: { op?: CodeLine["op"]; depth: number; text: string; enabled: boolean } }) {
  const op = l.op ?? "same";
  return (
    <div className={cx("code-line", op, !l.enabled && "disabled")}>
      <span className="code-gutter">{op === "added" ? "+" : op === "removed" ? "−" : " "}</span>
      <span className="code-text" style={{ paddingLeft: l.depth * 18 }}>
        {l.text}
        {!l.enabled && <span className="code-off">disabled</span>}
      </span>
    </div>
  );
}

function foldUnchanged(lines: CodeLine[]): { fold: boolean; lines: CodeLine[] }[] {
  const out: { fold: boolean; lines: CodeLine[] }[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].op !== "same") {
      out.push({ fold: false, lines: [lines[i++]] });
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].op === "same") j++;
    const run = lines.slice(i, j);
    const head = i === 0 ? 0 : CONTEXT, tail = j === lines.length ? 0 : CONTEXT;
    if (run.length > head + tail + 2) {
      out.push({ fold: false, lines: run.slice(0, head) });
      out.push({ fold: true, lines: run.slice(head, run.length - tail) });
      out.push({ fold: false, lines: run.slice(run.length - tail) });
    } else {
      out.push({ fold: false, lines: run });
    }
    i = j;
  }
  return out;
}

const addressType = (t: number) => (t === 1 ? "IP" : t === 3 ? "Zigbee" : `type ${t}`);

function searchText(c: Change): string {
  const parts: string[] = [c.kind];
  const s = subjectOf(c);
  if (s) parts.push(s.name, ...s.location);
  if (c.kind === "connection_added" || c.kind === "connection_removed") {
    const k = c.connection;
    parts.push(k.provider.device.name, k.consumer.device.name, k.provider.connection ?? "", k.consumer.connection ?? "", ...k.classes);
  }
  if ("property" in c) parts.push(c.property);
  if ("name" in c) parts.push(c.name);
  if (c.kind === "programming_changed") parts.push(c.event_name ?? "", ...c.lines.map((l) => l.text));
  return parts.join(" ").toLowerCase();
}
