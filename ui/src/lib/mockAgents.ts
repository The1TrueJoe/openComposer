/** The browser preview's built-in agents: a Scheduler with a week of events and an
 *  Announcements agent, answering `agent_view` and the scheduler ops the way
 *  app/src/agent_views.rs and crates/c4/src/agents.rs do. Fixture data only. */

import type { AgentView, Change, CodeLineView, ItemRef, NamedRef, Op, ScheduleRow, ScheduleSpec, Weekday } from "../api/types.ts";

type Ctx = {
  ref: (id: number) => NamedRef;
  itemRef: (id: number) => ItemRef;
  programming: (agent: number, event: number) => CodeLineView[];
  dropProgramming: (agent: number, event: number) => void;
};

type Entry = { id: number; spec: ScheduleSpec; locked: boolean; hidden: boolean; creator: number; category: string };

const spec = (s: Partial<ScheduleSpec> & Pick<ScheduleSpec, "name">): ScheduleSpec => ({
  enabled: true, time_base: "clock", minutes: 0, randomize_minutes: 0, start_date: "2025-01-01", start_on: null,
  repeat: "daily", every: 1, days: [], end_date: null, ...s,
});

// Ids match the fixture's programming ("90:1", "90:3") and catalog events.
const SCHEDULER = 90;
let nextId = 6;
const entries: Entry[] = [
  { id: 1, spec: spec({ name: "Sunset", time_base: "sunset" }), locked: false, hidden: false, creator: 0, category: "" },
  { id: 2, spec: spec({ name: "Sunrise", time_base: "sunrise", minutes: 15 }), locked: false, hidden: false, creator: 0, category: "" },
  { id: 3, spec: spec({ name: "Weekday 6:30 AM", minutes: 390, repeat: "weekly", days: ["monday", "tuesday", "wednesday", "thursday", "friday"] }),
    locked: false, hidden: false, creator: 0, category: "" },
  { id: 4, spec: spec({ name: "Holiday lights", time_base: "sunset", minutes: -10, start_date: "2025-12-01", end_date: "2026-01-06", enabled: false }),
    locked: false, hidden: false, creator: 0, category: "" },
  { id: 5, spec: spec({ name: "Component Auto Update Event", minutes: 201, repeat: "weekly",
    days: ["sunday", "monday", "tuesday", "wednesday", "friday", "saturday"] }), locked: false, hidden: false, creator: 44, category: "" },
];

const DAYS: Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SUN = { sunrise: "07:23", sunset: "18:36", timezone: "EDT" };

const clock = (m: number) => {
  const h = Math.floor(((m % 1440) + 1440) % 1440 / 60), mm = ((m % 60) + 60) % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function timeText(s: ScheduleSpec): string {
  const sun = (w: string) => (s.minutes === 0 ? w[0].toUpperCase() + w.slice(1) : s.minutes < 0 ? `${-s.minutes} min before ${w}` : `${s.minutes} min after ${w}`);
  const base = s.time_base === "clock" ? clock(s.minutes) : sun(s.time_base);
  return s.randomize_minutes > 0 ? `${base} (+ up to ${s.randomize_minutes} min)` : base;
}

export function repeatText(s: ScheduleSpec): string {
  if (s.repeat === "once") return "Once";
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[s.repeat];
  let t = s.every <= 1 ? `Every ${unit}` : `Every ${s.every} ${unit}s`;
  if (s.repeat === "weekly" && s.days.length) {
    const idx = [...new Set(s.days.map((d) => DAYS.indexOf(d)))].sort();
    const list = idx.length === 7 ? "every day" : idx.join() === "1,2,3,4,5" ? "weekdays" : idx.join() === "0,6" ? "weekends" : idx.map((i) => SHORT[i]).join(", ");
    t += ` on ${list}`;
  }
  return t;
}

const startText = (s: ScheduleSpec) => (s.start_on
  ? s.start_on.weekday ? `${s.start_on.nth} ${s.start_on.weekday[0].toUpperCase()}${s.start_on.weekday.slice(1)} of ${s.start_date.slice(0, 7)}` : `last day of ${s.start_date.slice(0, 7)}`
  : s.start_date);

/** Good enough for a preview: the next matching day at the entry's time (no monthly/yearly maths). */
function nextRun(s: ScheduleSpec): ScheduleRow["next"] {
  if (!s.enabled) return null;
  const minutes = s.time_base === "clock" ? s.minutes : toMin(s.time_base === "sunrise" ? SUN.sunrise : SUN.sunset) + s.minutes;
  const now = new Date();
  for (let d = 0; d < 400; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, 0, minutes);
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    if (day < now || iso < s.start_date) continue;
    if (s.end_date && iso > s.end_date) return null;
    if (s.repeat === "once" && iso !== s.start_date) continue;
    if (s.repeat === "weekly" && !s.days.includes(DAYS[day.getDay()])) continue;
    return { at: `${iso}T${String(day.getHours()).padStart(2, "0")}:${String(day.getMinutes()).padStart(2, "0")}`, timezone: SUN.timezone };
  }
  return null;
}

function row(e: Entry, ctx: Ctx): ScheduleRow {
  return {
    id: e.id, name: e.spec.name, enabled: e.spec.enabled, locked: e.locked, hidden: e.hidden,
    creator: e.creator ? ctx.ref(e.creator) : null, category: e.category,
    time: timeText(e.spec), repeat: repeatText(e.spec), start: startText(e.spec),
    end: e.spec.repeat === "once" ? null : e.spec.end_date, next: nextRun(e.spec), spec: e.spec,
    programming: ctx.programming(SCHEDULER, e.id),
  };
}

export function agentView(id: number, driver: string | null, name: string, ctx: Ctx): AgentView {
  const agent = { id, name };
  if (driver?.includes("scheduler")) {
    return { id, view: "scheduler", title: "Scheduler", agent, data: { sun: SUN, entries: entries.map((e) => row(e, ctx)) } };
  }
  if (driver?.includes("announcement")) {
    return { id, view: "announcements", title: "Announcements", agent, data: { announcements: [
      { id: 1, name: "Good Morning", audio: "chime.mp3", text: "Good morning!", image: null,
        rooms: [{ room: ctx.ref(11), volume: 30 }, { room: ctx.ref(13), volume: null }], screens: [] },
      { id: 2, name: "Doorbell", audio: "bell.mp3", text: "Someone is at the front door",
        image: "http://10.0.0.50/cgi/jpg/image.cgi?camera=1&username=viewer&password=••••",
        rooms: [{ room: ctx.ref(11), volume: null }, { room: ctx.ref(12), volume: 45 }], screens: [] },
    ] } };
  }
  return { id, view: null };
}

const find = (id: number) => {
  const e = entries.find((x) => x.id === id);
  if (!e) throw `the Scheduler has no event #${id}`;
  return e;
};

function check(s: ScheduleSpec, own?: number) {
  if (!s.name.trim()) throw "a scheduled event needs a name";
  if (s.time_base === "clock" && (s.minutes < 0 || s.minutes > 1439)) throw "a clock time is minutes after midnight, 0–1439";
  if (s.time_base !== "clock" && Math.abs(s.minutes) > 360) throw "the offset from sunrise/sunset must be between −360 and 360 minutes";
  if (s.repeat === "weekly" && !s.days.length) throw "an event repeating weekly needs at least one day";
  if (s.repeat !== "once" && s.end_date && s.end_date < s.start_date) throw "the end date can't be before the start date";
  if (entries.some((e) => e.id !== own && e.spec.name.trim().toLowerCase() === s.name.trim().toLowerCase())) throw `the Scheduler already has an event named “${s.name.trim()}”`;
}

type ScheduleOp = Extract<Op, { op: "add_schedule_entry" | "modify_schedule_entry" | "remove_schedule_entry" }>;
export const isScheduleOp = (op: Op): op is ScheduleOp => op.op.endsWith("_schedule_entry");

export function describeSchedule(op: ScheduleOp, agentName: string): string {
  switch (op.op) {
    case "add_schedule_entry": return `Add scheduled event “${op.entry.name}” to “${agentName}”: ${repeatText(op.entry)} at ${timeText(op.entry)}`;
    case "modify_schedule_entry": return `Change scheduled event “${entries.find((e) => e.id === op.id)?.spec.name ?? op.entry.name}” in “${agentName}”`;
    case "remove_schedule_entry": return `Remove scheduled event “${entries.find((e) => e.id === op.id)?.spec.name ?? `#${op.id}`}” from “${agentName}”`;
  }
}

const when = (s: ScheduleSpec) => `${repeatText(s)} at ${timeText(s)}, from ${startText(s)}${s.end_date && s.repeat !== "once" ? ` until ${s.end_date}` : ""}${s.enabled ? "" : " (disabled)"}`;

export function predictSchedule(op: ScheduleOp, ctx: Ctx): Change[] {
  const owner = ctx.itemRef(op.agent);
  switch (op.op) {
    case "add_schedule_entry":
      check(op.entry);
      return [{ kind: "schedule_added", owner, id: nextId, name: op.entry.name, when: when(op.entry) }];
    case "modify_schedule_entry": {
      const e = find(op.id);
      check(op.entry, op.id);
      const fields: [string, string, string][] = [
        ["name", e.spec.name, op.entry.name], ["time", timeText(e.spec), timeText(op.entry)], ["start", startText(e.spec), startText(op.entry)],
        ["repeats", repeatText(e.spec), repeatText(op.entry)], ["end", e.spec.end_date ?? "none", op.entry.end_date ?? "none"],
        ["state", e.spec.enabled ? "enabled" : "disabled", op.entry.enabled ? "enabled" : "disabled"],
      ];
      return fields.filter(([, a, b]) => a !== b).map(([field, from, to]) => ({ kind: "schedule_changed", owner, id: op.id, name: op.entry.name, field, from, to }));
    }
    case "remove_schedule_entry": {
      const e = find(op.id);
      return [{ kind: "schedule_removed", owner, id: op.id, name: e.spec.name, when: when(e.spec), cascade: false }];
    }
  }
}

export function applySchedule(op: ScheduleOp, ctx: Ctx): void {
  switch (op.op) {
    case "add_schedule_entry":
      entries.push({ id: nextId++, spec: op.entry, locked: false, hidden: false, creator: 0, category: "" });
      return;
    case "modify_schedule_entry":
      find(op.id).spec = op.entry;
      return;
    case "remove_schedule_entry":
      entries.splice(entries.indexOf(find(op.id)), 1);
      ctx.dropProgramming(op.agent, op.id);
  }
}
