/** Pieces the built-in agents' tabs share: links to items, the approval round-trip, an
 *  inline editor card, and the pickers editors are made of. */

import { Check, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { NamedRef, Op } from "../../../api";
import type { Shell } from "../../../lib/shell";
import { cx } from "../../../lib/ui";

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
