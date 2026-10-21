/** The Scheduler agent's own tab, in place of Composer's Scheduler plugin: every scheduled
 *  event with its time, repeat and next run, and the programming it starts. Events are added,
 *  edited and removed as approvals (add/modify/remove_schedule_entry). */

import { CalendarClock, Clock, Lock, Moon, Pencil, Plus, SquareCode, Sun, Sunrise, Sunset, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Frequency, Nth, Op, ScheduleRow, ScheduleSpec, TimeBase, Weekday } from "../../../api";
import { CodeRow } from "../../../components/DiffView";
import { Tip, useDialog } from "../../../components/Dialogs";
import { Select, Switch } from "../../../components/controls";
import type { Shell } from "../../../lib/shell";
import { cx, plural } from "../../../lib/ui";

type Data = { sun: { sunrise: string; sunset: string; timezone: string } | null; entries: ScheduleRow[] };

const DAYS: { id: Weekday; short: string }[] = [
  { id: "sunday", short: "Sun" }, { id: "monday", short: "Mon" }, { id: "tuesday", short: "Tue" }, { id: "wednesday", short: "Wed" },
  { id: "thursday", short: "Thu" }, { id: "friday", short: "Fri" }, { id: "saturday", short: "Sat" },
];

/** "18:36" → "6:36 PM" */
const hhmm12 = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** When it next runs, the way people say it: "Today 6:35 PM", "Tomorrow 3:21 AM", "Thu Oct 23". */
function nextText(at: string): { day: string; time: string; soon: boolean } {
  const [date, t] = at.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const target = new Date(y, mo - 1, d);
  const now = new Date();
  const days = Math.round((target.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  const day = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days < 7 && days > 0
    ? target.toLocaleDateString(undefined, { weekday: "long" })
    : target.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: y === now.getFullYear() ? undefined : "numeric" });
  return { day, time: hhmm12(t), soon: days <= 1 };
}

function TimeIcon({ base }: { base: TimeBase }) {
  const p = { size: 14, strokeWidth: 1.8 };
  return base === "sunrise" ? <Sunrise {...p} /> : base === "sunset" ? <Sunset {...p} /> : <Clock {...p} />;
}

export function SchedulerView({ agent, data, shell, reload }: {
  agent: { id: number; name: string }; data: Data; shell: Shell; reload: () => void;
}) {
  const dialog = useDialog();
  const [system, setSystem] = useState(false);
  const [editing, setEditing] = useState<ScheduleRow | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const w = shell.writable;
  const why = w ? undefined : `${shell.director?.name ?? "This Director"} is read-only`;

  // Composer hides other agents' bookkeeping (Update Manager's nightly checks…) from nobody,
  // but people rarely care: keep them behind a switch.
  const systemCount = data.entries.filter((e) => e.creator || e.hidden).length;
  const shown = data.entries.filter((e) => system || (!e.creator && !e.hidden));
  const { upcoming, idle } = useMemo(() => {
    const up = shown.filter((e) => e.next).sort((a, b) => a.next!.at.localeCompare(b.next!.at));
    return { upcoming: up, idle: shown.filter((e) => !e.next) };
  }, [shown]);

  const propose = async (ops: Op[], reason: string) => {
    setBusy(true);
    try {
      const r = await shell.propose(ops, reason);
      if (r?.status === "applied") {
        setEditing(null);
        reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e: ScheduleRow) => {
    const lines = e.programming.length;
    const ok = await dialog.confirm({
      title: `Remove “${e.name}”?`,
      description: lines ? `Its programming (${plural(lines, "line")}) goes with it.` : "It has no programming.",
      confirmLabel: "Remove", danger: true,
    });
    if (ok) await propose([{ op: "remove_schedule_entry", agent: agent.id, id: e.id }], `Remove the scheduled event “${e.name}”.`);
  };

  return (
    <div className="ag ag-sched">
      <div className="ag-bar">
        {data.sun && (
          <span className="ag-sun" title={`Today at the controller (${data.sun.timezone})`}>
            <Sun size={13} strokeWidth={1.8} /> Sunrise <b>{hhmm12(data.sun.sunrise)}</b>
            <Moon size={13} strokeWidth={1.8} /> Sunset <b>{hhmm12(data.sun.sunset)}</b>
            {data.sun.timezone && <span className="dim">{data.sun.timezone}</span>}
          </span>
        )}
        <span className="spread" />
        {systemCount > 0 && (
          <label className="ag-switch">
            <Switch checked={system} onCheckedChange={setSystem} label="Show other agents' events" />
            <span>Agents' events <span className="dim">({systemCount})</span></span>
          </label>
        )}
        <Tip text={why ?? "Add a scheduled event"}>
          <span><button className="act small primary" disabled={!w || busy} onClick={() => setEditing("new")}><Plus size={13} strokeWidth={2} />Add event</button></span>
        </Tip>
      </div>

      {editing && (
        <EntryEditor
          key={editing === "new" ? "new" : editing.id}
          entry={editing === "new" ? null : editing}
          sun={data.sun}
          busy={busy}
          taken={data.entries.filter((e) => editing === "new" || e.id !== editing.id).map((e) => e.name.trim().toLowerCase())}
          onCancel={() => setEditing(null)}
          onSave={(spec) => editing === "new"
            ? propose([{ op: "add_schedule_entry", agent: agent.id, entry: spec }], `Add the scheduled event “${spec.name}”.`)
            : propose([{ op: "modify_schedule_entry", agent: agent.id, id: editing.id, entry: spec, creator: editing.creator?.id ?? 0, category: editing.category }],
                `Change the scheduled event “${editing.name}”.`)}
        />
      )}

      {!shown.length && !editing && <p className="empty pad">No scheduled events{systemCount ? " of your own" : ""} yet.</p>}
      {!!upcoming.length && <h4 className="ag-h">Coming up</h4>}
      {upcoming.map((e) => <EntryRow key={e.id} e={e} agent={agent.id} shell={shell} why={why} busy={busy} onEdit={() => setEditing(e)} onRemove={() => remove(e)} />)}
      {!!idle.length && <h4 className="ag-h">Disabled or finished</h4>}
      {idle.map((e) => <EntryRow key={e.id} e={e} agent={agent.id} shell={shell} why={why} busy={busy} onEdit={() => setEditing(e)} onRemove={() => remove(e)} />)}
    </div>
  );
}

function EntryRow({ e, agent, shell, why, busy, onEdit, onRemove }: {
  e: ScheduleRow; agent: number; shell: Shell; why?: string; busy: boolean; onEdit: () => void; onRemove: () => void;
}) {
  const next = e.next ? nextText(e.next.at) : null;
  const program = () => shell.program({ device: agent, event: e.id });
  const canEdit = !why && !e.locked && !busy;
  return (
    <div className={cx("ag-card ag-entry", !e.enabled && "off")}>
      <div className="ag-entry-main">
        <span className={cx("ag-time", e.spec.time_base)}><TimeIcon base={e.spec.time_base} />{e.time}</span>
        <div className="ag-entry-what">
          <div className="ag-entry-name">
            <b>{e.name}</b>
            {!e.enabled && <span className="tag">disabled</span>}
            {e.locked && <Tip text="Locked: Composer doesn't allow changing it either"><span className="tag"><Lock size={10} strokeWidth={2} />locked</span></Tip>}
            {e.creator && <span className="tag accent" title="Made by another agent">by {e.creator.name}</span>}
          </div>
          <div className="dim small">
            {e.repeat} · from {e.start}{e.end && <> · until {e.end}</>}
          </div>
        </div>
        <div className="ag-entry-next">
          {next ? <><span className={cx("ag-next-day", next.soon && "soon")}>{next.day}</span><span className="dim small">{next.time}</span></>
            : <span className="dim small">{e.enabled ? "won't run again" : "off"}</span>}
        </div>
        <div className="ag-entry-acts">
          <Tip text={e.programming.length ? "Open its programming" : "Program what happens when it runs"}>
            <button className={cx("ag-prog", !!e.programming.length && "has")} onClick={program}>
              <SquareCode size={13} strokeWidth={1.8} />{e.programming.length ? plural(e.programming.length, "line") : "Program"}
            </button>
          </Tip>
          <Tip text={why ?? (e.locked ? "Locked" : "Edit")}>
            <span><button className="icon-btn" aria-label="Edit" disabled={!canEdit} onClick={onEdit}><Pencil size={13} strokeWidth={1.8} /></button></span>
          </Tip>
          <Tip text={why ?? (e.locked ? "Locked" : "Remove")}>
            <span><button className="icon-btn danger" aria-label="Remove" disabled={!canEdit} onClick={onRemove}><Trash2 size={13} strokeWidth={1.8} /></button></span>
          </Tip>
        </div>
      </div>
      {!!e.programming.length && (
        <div className="code ag-code" role="button" tabIndex={0} title="Open in Programming" onClick={program}
             onKeyDown={(k) => { if (k.key === "Enter") program(); }}>
          {e.programming.map((l) => <CodeRow key={l.id} line={l} />)}
        </div>
      )}
    </div>
  );
}

const BLANK = (): ScheduleSpec => ({
  name: "", enabled: true, time_base: "clock", minutes: 18 * 60, randomize_minutes: 0, start_date: today(), start_on: null,
  repeat: "daily", every: 1, days: [], end_date: null,
});

const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Composer's "Edit Entry" dialog, inline. The backend checks the same rules again. */
function EntryEditor({ entry, sun, busy, taken, onCancel, onSave }: {
  entry: ScheduleRow | null; sun: Data["sun"]; busy: boolean; taken: string[];
  onCancel: () => void; onSave: (s: ScheduleSpec) => void;
}) {
  const [s, setS] = useState<ScheduleSpec>(() => (entry ? { ...entry.spec, days: [...entry.spec.days] } : BLANK()));
  const set = (patch: Partial<ScheduleSpec>) => setS((x) => ({ ...x, ...patch }));
  const sunBase = s.time_base !== "clock";
  const relation = s.minutes === 0 ? "at" : s.minutes < 0 ? "before" : "after";

  const problem = (() => {
    if (!s.name.trim()) return "Give it a name.";
    if (taken.includes(s.name.trim().toLowerCase())) return "Another event already has that name.";
    if (sunBase && Math.abs(s.minutes) > 360) return "Up to 360 minutes before or after.";
    if (s.randomize_minutes < 0 || s.randomize_minutes > 60) return "Random delay is 0–60 minutes.";
    if (s.repeat !== "once" && (s.every < 1 || s.every > 100)) return "Repeat every 1–100.";
    if (s.repeat === "weekly" && !s.days.length) return "Pick at least one day.";
    if (s.repeat !== "once" && s.end_date && s.end_date < s.start_date) return "It can't end before it starts.";
    if (!s.start_date) return "Pick a start date.";
    return null;
  })();

  const unit = { once: "", daily: "day", weekly: "week", monthly: "month", yearly: "year" }[s.repeat];

  return (
    <form className="ag-card ag-editor" onSubmit={(e) => { e.preventDefault(); if (!problem) onSave({ ...s, name: s.name.trim(), end_date: s.repeat === "once" ? null : s.end_date }); }}>
      <div className="ag-editor-head">
        <CalendarClock size={15} strokeWidth={1.8} />
        <b>{entry ? `Edit “${entry.name}”` : "New scheduled event"}</b>
        <span className="spread" />
        <label className="ag-switch"><Switch checked={s.enabled} onCheckedChange={(v) => set({ enabled: v })} label="Enabled" /><span>Enabled</span></label>
      </div>

      <div className="ag-form">
        <label>Name</label>
        <input autoFocus value={s.name} placeholder="e.g. Porch lights at dusk" onChange={(e) => set({ name: e.target.value })} />

        <label>Time</label>
        <div className="ag-row">
          <div className="ag-seg" role="radiogroup" aria-label="Time is measured from">
            {(["clock", "sunrise", "sunset"] as TimeBase[]).map((b) => (
              <button type="button" key={b} role="radio" aria-checked={s.time_base === b} className={cx(s.time_base === b && "on")}
                      onClick={() => set({ time_base: b, minutes: b === "clock" ? (sunBase ? 18 * 60 : s.minutes) : (sunBase ? s.minutes : 0) })}>
                <TimeIcon base={b} />{b === "clock" ? "Clock" : b === "sunrise" ? "Sunrise" : "Sunset"}
              </button>
            ))}
          </div>
          {!sunBase ? (
            <input type="time" value={toHHMM(s.minutes)} onChange={(e) => {
              const [h, m] = e.target.value.split(":").map(Number);
              if (!Number.isNaN(h)) set({ minutes: h * 60 + (m || 0) });
            }} />
          ) : (
            <>
              <Select<"at" | "before" | "after"> value={relation} label="Before or after"
                options={[{ value: "at", label: `At ${s.time_base}` }, { value: "before", label: "Minutes before" }, { value: "after", label: "Minutes after" }]}
                onValueChange={(v) => set({ minutes: v === "at" ? 0 : (v === "before" ? -1 : 1) * Math.max(1, Math.abs(s.minutes) || 15) })} />
              {relation !== "at" && <input className="narrow" type="number" min={1} max={360} value={Math.abs(s.minutes)}
                onChange={(e) => set({ minutes: (relation === "before" ? -1 : 1) * Math.max(0, Number(e.target.value) || 0) })} />}
              {sun && <span className="dim small">today {hhmm12(s.time_base === "sunrise" ? sun.sunrise : sun.sunset)}</span>}
            </>
          )}
        </div>

        <label>Randomize</label>
        <div className="ag-row">
          <input className="narrow" type="number" min={0} max={60} value={s.randomize_minutes} onChange={(e) => set({ randomize_minutes: Number(e.target.value) || 0 })} />
          <span className="dim small">minutes later at most, at random (0 = exactly on time)</span>
        </div>

        <label>Starts</label>
        <div className="ag-row">
          <input type="date" value={s.start_date} onChange={(e) => set({ start_date: e.target.value })} />
          <label className="ag-check">
            <input type="checkbox" checked={!!s.start_on} onChange={(e) => set({ start_on: e.target.checked ? { nth: "first", weekday: "monday" } : null })} />
            on the
          </label>
          {s.start_on && <>
            <Select<Nth> value={s.start_on.nth} label="Which week"
              options={(["first", "second", "third", "fourth", "last"] as Nth[]).map((n) => ({ value: n, label: n }))}
              onValueChange={(nth) => set({ start_on: { nth, weekday: nth === "last" ? s.start_on!.weekday : s.start_on!.weekday ?? "monday" } })} />
            <Select<Weekday | "day"> value={s.start_on.weekday ?? "day"} label="Weekday"
              options={[...DAYS.map((d) => ({ value: d.id as Weekday | "day", label: d.id[0].toUpperCase() + d.id.slice(1) })),
                ...(s.start_on.nth === "last" ? [{ value: "day" as const, label: "day" }] : [])]}
              onValueChange={(v) => set({ start_on: { nth: s.start_on!.nth, weekday: v === "day" ? null : v } })} />
            <span className="dim small">of that month</span>
          </>}
        </div>

        <label>Repeats</label>
        <div className="ag-row">
          <Select<Frequency> value={s.repeat} label="Repeats"
            options={[{ value: "once", label: "Never (once)" }, { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }]}
            onValueChange={(v) => set({ repeat: v, days: v === "weekly" && !s.days.length ? DAYS.slice(1, 6).map((d) => d.id) : s.days })} />
          {s.repeat !== "once" && <>
            <span className="dim small">every</span>
            <input className="narrow" type="number" min={1} max={100} value={s.every} onChange={(e) => set({ every: Number(e.target.value) || 1 })} />
            <span className="dim small">{s.every === 1 ? unit : `${unit}s`}</span>
          </>}
        </div>

        {s.repeat === "weekly" && <>
          <label>On</label>
          <div className="ag-days" role="group" aria-label="Days">
            {DAYS.map((d) => {
              const on = s.days.includes(d.id);
              return <button type="button" key={d.id} aria-pressed={on} className={cx(on && "on")}
                             onClick={() => set({ days: on ? s.days.filter((x) => x !== d.id) : [...s.days, d.id] })}>{d.short}</button>;
            })}
          </div>
        </>}

        {s.repeat !== "once" && <>
          <label>Ends</label>
          <div className="ag-row">
            <label className="ag-check">
              <input type="checkbox" checked={!!s.end_date} onChange={(e) => set({ end_date: e.target.checked ? s.end_date ?? s.start_date : null })} />
              on
            </label>
            {s.end_date ? <input type="date" value={s.end_date} onChange={(e) => set({ end_date: e.target.value })} /> : <span className="dim small">never</span>}
          </div>
        </>}
      </div>

      <div className="ag-editor-foot">
        {problem && <span className="ag-problem">{problem}</span>}
        <span className="spread" />
        <button type="button" className="act small" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="act small primary" disabled={!!problem || busy}>{entry ? "Save changes" : "Add event"}</button>
      </div>
    </form>
  );
}
