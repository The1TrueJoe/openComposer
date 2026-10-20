import {
  ArrowRight, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, EyeOff, Network, Package, Plug, Sparkles, User,
} from "lucide-react";
import { Fragment, memo, useMemo, useState } from "react";
import type { Change, CodeLine, Diff, Endpoint, ItemRef } from "../api";
import { effectOf, group, inlineDiff, isCascade, subjectOf, tally, type Effect, type SectionId, type Seg } from "../lib/diff";
import { ago, cx, dateTime, plural } from "../lib/ui";
import { DiffGraph } from "./DiffGraph";
import { KindIcon } from "./icons";
import { Tip } from "./Dialogs";

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
export function DiffView({ diff, header, graph = true, empty = "No differences." }: {
  diff: Diff;
  header?: DiffHeader;
  /** The affected-devices map above the sections (off for nested side-effect diffs). */
  graph?: boolean;
  empty?: string;
}) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? diff.changes.filter((c) => searchText(c).includes(q)) : diff.changes;
  }, [diff.changes, filter]);
  const sections = useMemo(() => group(shown), [shown]);
  const [closed, setClosed] = useState<Set<SectionId>>(
    () => new Set(group(diff.changes).filter((s) => s.changes.length > COLLAPSE_OVER).map((s) => s.id)));
  const [showGraph, setShowGraph] = useState(true);
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
        {sections.length > 1 && (
          <Tip text={closed.size ? "Expand all" : "Collapse all"}>
            <button className="icon-btn" aria-label={closed.size ? "Expand all" : "Collapse all"}
                    onClick={() => setClosed(closed.size ? new Set() : new Set(sections.map((s) => s.id)))}>
              {closed.size ? <ChevronsUpDown size={14} strokeWidth={1.8} /> : <ChevronsDownUp size={14} strokeWidth={1.8} />}
            </button>
          </Tip>
        )}
      </div>
      {graph && hasConnections && showGraph && <DiffGraph changes={diff.changes} />}
      {!diff.changes.length && <p className="empty dv-empty">{empty}</p>}
      {!!diff.changes.length && !shown.length && <p className="empty dv-empty">No change matches “{filter}”.</p>}
      {sections.map((s) => (
        <Section key={s.id} id={s.id} title={s.title} changes={s.changes} open={!closed.has(s.id)}
                 onToggle={() => setClosed((c) => { const n = new Set(c); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
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

function Section({ id, title, changes, open, onToggle }: {
  id: SectionId; title: string; changes: Change[]; open: boolean; onToggle: () => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const t = tally(changes);
  const visible = changes.slice(0, limit);
  return (
    <section className={cx("dv-sec", `dv-${id}`)}>
      <button className="dv-sec-head" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={13} strokeWidth={1.8} /> : <ChevronRight size={13} strokeWidth={1.8} />}
        <span className="dv-sec-title">{title}</span>
        <span className="dv-count">{changes.length}</span>
        <span className="dv-mini">
          {!!t.added && <span className="added">+{t.added}</span>}
          {!!t.removed && <span className="removed">−{t.removed}</span>}
          {!!t.changed && <span className="changed">~{t.changed}</span>}
        </span>
      </button>
      {open && (
        <div className="dv-rows">
          {id === "properties" ? <PropertyRows changes={visible} /> : visible.map((c, i) => <Row key={i} change={c} />)}
          {changes.length > limit && (
            <button className="dv-more" onClick={() => setLimit(limit + PAGE * 4)}>
              Show {Math.min(PAGE * 4, changes.length - limit)} more of {changes.length - limit} remaining
            </button>
          )}
        </div>
      )}
    </section>
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

const Row = memo(function Row({ change: c }: { change: Change }) {
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
          <Crumbs parts={c.item.location} />
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
          <Crumbs parts={c.item.location} />
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
          <Crumbs parts={c.item.location} />
        </div>
      );
    case "connection_added":
    case "connection_removed":
      return (
        <div className={cls}>
          <Gutter effect={effect} />
          <Wire provider={c.connection.provider} consumer={c.connection.consumer} classes={c.connection.classes} effect={effect} />
          {c.kind === "connection_removed" && c.cascade && <span className="tag warn">removed with device</span>}
        </div>
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
    case "property_changed":
      return null; // drawn by PropertyRows, grouped under their item
  }
});

/** Properties grouped under their item: ten changed properties of one driver read as one
 *  device being reconfigured, not ten unrelated things. */
function PropertyRows({ changes }: { changes: Change[] }) {
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
          <div className="dv-pitem"><Name item={g.item} /><Crumbs parts={g.item.location} /></div>
          {g.rows.map((c, j) => (
            <div key={j} className={cx("dv-row changed", c.from == null && "added", c.to == null && "removed")}>
              <Gutter effect={c.from == null ? "added" : c.to == null ? "removed" : "changed"} />
              <span className="dv-prop">{c.property}</span>
              <ValueChange from={c.from} to={c.to} />
            </div>
          ))}
        </div>
      ))}
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
