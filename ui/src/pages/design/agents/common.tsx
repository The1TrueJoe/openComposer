/** Pieces the built-in agents' tabs share: the table-and-detail layout every tab uses, links to
 *  items, the approval round-trip, an inline editor card, and the pickers editors are made of. */

import { Check, Pencil, SquareCode, Trash2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { NamedRef, Op } from "../../../api";
import { Tip } from "../../../components/Dialogs";
import { WithDetail } from "../../../components/Panes";
import type { Shell } from "../../../lib/shell";
import { cx, plural } from "../../../lib/ui";

/** Every agent tab's layout: a bar (counts, switches, Add), a table of its records (Scheduler
 *  events, scenes…), and the picked one — or the editor — in a resizable pane under it. */
export function AgentSplit({ id, bar, detail, defaultSize = "58%", children }: {
  id: string; bar: ReactNode; detail: ReactNode; defaultSize?: string; children: ReactNode;
}) {
  return (
    <div className="ag ag-split">
      <div className="ag-bar">{bar}</div>
      <WithDetail id={`agent-${id}`} detail={detail} defaultSize={defaultSize} minSize={140}>{children}</WithDetail>
    </div>
  );
}

/** The picked record: its name and actions, then what it holds (scrolling), or with `fill`
 *  a body that lays itself out (a second table). */
export function DetailPane({ icon, title, tags, actions, fill, children }: {
  icon: ReactNode; title: ReactNode; tags?: ReactNode; actions?: ReactNode; fill?: boolean; children: ReactNode;
}) {
  return (
    <div className="ag-detail">
      <div className="ag-detail-head">
        {icon}
        <b className="ag-detail-title">{title}</b>
        {tags}
        <span className="spread" />
        {actions}
      </div>
      <div className={cx("ag-detail-body", fill && "fill")}>{children}</div>
    </div>
  );
}

/** An icon button with its reason (or why it's off) as the tip. */
export function IconAct({ label, why, danger, disabled, onClick, children }: {
  label: string; why?: string; danger?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <Tip text={why ?? label}>
      <span><button className={cx("icon-btn", danger && "danger")} aria-label={label} disabled={disabled || !!why} onClick={onClick}>{children}</button></span>
    </Tip>
  );
}

export const EditIcon = () => <Pencil size={13} strokeWidth={1.8} />;
export const RemoveIcon = () => <Trash2 size={13} strokeWidth={1.8} />;

/** "3 lines" — opens the event in Programming; "Program" when it has none yet. */
export function ProgramLink({ lines, label, onClick }: { lines: number; label?: string; onClick: () => void }) {
  return (
    <Tip text={lines ? "Open its programming" : "Program what happens"}>
      <button type="button" className={cx("ag-prog", !!lines && "has")} onClick={onClick}>
        <SquareCode size={13} strokeWidth={1.8} />{label ?? (lines ? plural(lines, "line") : "Program")}
      </button>
    </Tip>
  );
}

export const Ref = ({ r, onSelect }: { r: NamedRef; onSelect: (id: number) => void }) =>
  r.id === 0 ? <span>{r.name}</span> : (
    <button className="ag-ref" onClick={() => onSelect(r.id)} title={r.room ? `${r.name} in ${r.room}` : r.name}>
      {r.name}{r.room && r.room !== r.name && <span className="dim"> · {r.room}</span>}
    </button>
  );

/** "Left Lamp · Office" for a picker. */
export const refLabel = (r: NamedRef) => (r.room && r.room !== r.name ? `${r.name} · ${r.room}` : r.name);

export const ms = (n: number) => (n >= 60_000 && n % 60_000 === 0 ? `${n / 60_000} min` : n >= 1000 ? `${+(n / 1000).toFixed(1)} s` : `${n} ms`);

/** Changes go out as approvals; `why` says why they can't (a read-only Director). */
export function useWrites(shell: Shell, reload: () => void) {
  const [busy, setBusy] = useState(false);
  const why = shell.writable ? undefined : `${shell.director?.name ?? "This Director"} is read-only`;
  const propose = async (ops: Op[], reason: string): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await shell.propose(ops, reason);
      if (r?.status === "applied") {
        reload();
        return true;
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, why, can: !why && !busy, propose };
}

/** An inline editor: what it edits, the form, and Save/Cancel with the first problem shown. */
export function EditorCard({ icon, title, problem, busy, saveLabel, onCancel, onSave, children, aside }: {
  icon: ReactNode; title: string; problem: string | null; busy: boolean; saveLabel: string;
  onCancel: () => void; onSave: () => void; children: ReactNode; aside?: ReactNode;
}) {
  return (
    <form className="ag-card ag-editor" onSubmit={(e) => { e.preventDefault(); if (!problem && !busy) onSave(); }}>
      <div className="ag-editor-head">
        {icon}
        <b>{title}</b>
        <span className="spread" />
        {aside}
      </div>
      <div className="ag-form">{children}</div>
      <div className="ag-editor-foot">
        {problem && <span className="ag-problem">{problem}</span>}
        <span className="spread" />
        <button type="button" className="act small" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="act small primary" disabled={!!problem || busy}>{saveLabel}</button>
      </div>
    </form>
  );
}

/** Pick any number of items (lights, screens, rooms) from a list, shown as toggle chips. */
export function MultiPick({ options, value, onChange, empty }: {
  options: NamedRef[]; value: number[]; onChange: (ids: number[]) => void; empty?: string;
}) {
  if (!options.length) return <span className="dim small">{empty ?? "Nothing to choose from"}</span>;
  return (
    <div className="ag-chips" role="group">
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button type="button" key={o.id} aria-pressed={on} className={cx("ag-chip", on && "on")} title={refLabel(o)}
                  onClick={() => onChange(on ? value.filter((x) => x !== o.id) : [...value, o.id])}>
            {on ? <Check size={11} strokeWidth={2.2} /> : null}{o.name}{o.room && o.room !== o.name && <span className="dim"> · {o.room}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** A volume that may be "the room's current volume" (null). */
export function VolumeInput({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  return (
    <span className="ag-vol">
      <label className="ag-check">
        <input type="checkbox" checked={value != null} onChange={(e) => onChange(e.target.checked ? 50 : null)} aria-label={`Set ${label} volume`} />
        {value == null ? <span className="dim">current volume</span> : null}
      </label>
      {value != null && <><input className="narrow" type="number" min={0} max={100} value={value} aria-label={`${label} volume`}
        onChange={(e) => onChange(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} /><span className="dim small">%</span></>}
    </span>
  );
}

export const RemoveChip = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button type="button" className="icon-btn" aria-label={label} title={label} onClick={onClick}><X size={12} strokeWidth={2} /></button>
);
