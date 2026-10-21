/** The browser preview's built-in agents: a Scheduler with a week of events, Advanced
 *  Lighting scenes, announcements, a Wake/Sleep room and notifications, answering
 *  `agent_view` and the agents' ops roughly the way app/src/agent_views.rs and
 *  crates/c4/src/agent_ops.rs do. Fixture data only. */

import type {
  AgentView, AnnouncementSpec, Change, CodeLineView, EmailTemplateSpec, ItemRef, LightStep, NamedRef, Op, PushTemplateSpec, ScheduleRow, ScheduleSpec,
  WakeSleepSpec, Weekday,
} from "../api/types.ts";

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

// ---- the other agents (Advanced Lighting, Announcements, Wake/Sleep, notifications) --------------

const LIGHTING = 92, ANNOUNCE = 91;
let lightingNext = 3, announceNext = 3, wakeNext = 2, pushNext = 3, emailNext = 2;

const scenes: { id: number; name: string; members: { device: number; steps: LightStep[] }[] }[] = [
  { id: 0, name: "Kitchen Cooking", members: [{ device: 31, steps: [{ delay_ms: 0, level: 100, rate_ms: 1000, color: { kelvin: 4000 } }] }] },
  { id: 1, name: "Kitchen Evening", members: [{ device: 31, steps: [{ delay_ms: 0, level: 40, rate_ms: 3000, color: { kelvin: 2700 } },
    { delay_ms: 600_000, level: 20, rate_ms: 60_000, color: null }] }] },
  { id: 2, name: "All Off", members: [{ device: 31, steps: [{ delay_ms: 0, level: 0, rate_ms: 750, color: null }] }] },
];
const announcements: { id: number; spec: AnnouncementSpec }[] = [
  { id: 1, spec: { name: "Good Morning", audio: "chime.mp3", text: "Good morning!", image: null, display_seconds: 30, ok_button: true,
    rooms: [{ id: 11, volume: 30 }, { id: 13, volume: null }], screens: [], touchscreen_audio: [] } },
  { id: 2, spec: { name: "Doorbell", audio: "bell.mp3", text: "Someone is at the front door",
    image: "http://10.0.0.50/cgi/jpg/image.cgi?camera=1&username=viewer&password=••••", display_seconds: 60, ok_button: true,
    rooms: [{ id: 11, volume: null }, { id: 12, volume: 45 }], screens: [], touchscreen_audio: [] } },
];
const WAKE_DEFAULT = (): WakeSleepSpec => ({
  wake_time: "06:30", wake_days: [], sleep_minutes: 15,
  lights: { visible: true, enabled: true, light: 0, ramp_minutes: 1 },
  media: { visible: true, enabled: true, source: 0, kind: "", item: 0, tv_only: false },
  blinds: { visible: true, enabled: true, blind: 0 },
  temperature: { visible: false, enabled: true, mode: "Cool", setpoint_f: 72 },
});
const wakeRooms: { id: number; room: number; settings: WakeSleepSpec }[] = [
  { id: 1, room: 13, settings: { ...WAKE_DEFAULT(), wake_time: "07:00", wake_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], sleep_minutes: 30,
    media: { visible: true, enabled: false, source: 0, kind: "watch", item: 0, tv_only: true } } },
];
const CATEGORIES = [{ id: 1, name: "Lighting" }, { id: 2, name: "Security" }, { id: 9, name: "Comfort" }];
const SEVERITIES = [{ id: 2, name: "Alarms" }, { id: 3, name: "Alerts" }, { id: 4, name: "Informational" }];
const pushes: { id: number; spec: PushTemplateSpec }[] = [
  { id: 1, spec: { name: "Garage left open", category: 2, severity: 3, subject: "The garage door is still open", message: "", timestamp: true, attachments: [] } },
  { id: 2, spec: { name: "Too warm", category: 9, severity: 4, subject: "The bedroom is above 78°", message: "", timestamp: true, attachments: [] } },
];
const emails: { id: number; spec: EmailTemplateSpec }[] = [
  { id: 1, spec: { name: "Daily summary", to: "owner@example.com", subject: "House summary", body: "All quiet.", timestamp: true } },
];

const stepText = (st: LightStep) => {
  const parts = [st.level == null ? null : st.level === 0 ? "off" : `${st.level}%`,
    st.color == null ? null : "kelvin" in st.color ? `${st.color.kelvin} K` : `hue ${st.color.hue}°, saturation ${st.color.saturation}%`].filter(Boolean);
  const ms = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(1)} s` : `${n} ms`);
  return `${st.delay_ms ? `after ${ms(st.delay_ms)}: ` : ""}${parts.join(", ")} over ${ms(st.rate_ms)}`;
};

const lights = (ctx: Ctx) => [31].map((id) => ctx.ref(id));

export function agentView(id: number, driver: string | null, name: string, ctx: Ctx): AgentView {
  const agent = { id, name };
  const d = driver ?? "";
  if (d.includes("scheduler")) {
    return { id, view: "scheduler", title: "Scheduler", agent, data: { sun: SUN, entries: entries.map((e) => row(e, ctx)) } };
  }
  if (d.includes("adv_lighting")) {
    return { id, view: "advanced_lighting", title: "Advanced Lighting", agent, data: {
      lights: lights(ctx),
      scenes: scenes.map((s) => ({ id: s.id, name: s.name, active: s.id === 2, ramp_capable: true, toggle: null,
        programmed: [0, 1, 4].reduce((n, e) => n + ctx.programming(LIGHTING, s.id * 5 + e).length, 0),
        members: s.members.map((m) => ({ device: ctx.ref(m.device), steps: m.steps.map((st) => ({ ...st, text: stepText(st) })) })) })),
    } };
  }
  if (d.includes("announcements")) {
    return { id, view: "announcements", title: "Announcements", agent, data: {
      announcements: announcements.map(({ id: aid, spec }) => ({
        id: aid, name: spec.name, audio: spec.audio, text: spec.text || null, image: spec.image, display_seconds: spec.display_seconds, ok_button: spec.ok_button,
        rooms: spec.rooms.map((r) => ({ room: ctx.ref(r.id), volume: r.volume })), screens: spec.screens.map((s) => ({ device: ctx.ref(s), onscreen: true })),
        touchscreen_audio: spec.touchscreen_audio.map((t) => ({ device: ctx.ref(t.id), volume: t.volume })),
        programmed: ctx.programming(ANNOUNCE, aid).length, spec: structuredClone(spec) })),
      rooms: [10, 11, 12, 13].map((r) => ctx.ref(r)), screens: [ctx.ref(44)], touchscreens: [],
      sounds: ["bell.mp3", "chime.mp3"], display_seconds: [5, 10, 15, 20, 25, 30, 60, 300, 600],
    } };
  }
  if (d.includes("wakeup_goodnight")) {
    return { id, view: "wake_sleep", title: "Wake/Sleep", agent, data: {
      rooms: wakeRooms.map((w) => ({ id: w.id, room: ctx.ref(w.room), settings: structuredClone(w.settings),
        light: w.settings.lights.light ? ctx.ref(w.settings.lights.light) : { id: 0, name: "All lights in the room", room: null },
        blind: w.settings.blinds.blind ? ctx.ref(w.settings.blinds.blind) : { id: 0, name: "All blinds in the room", room: null },
        source: w.settings.media.source ? ctx.ref(w.settings.media.source).name : w.settings.media.kind === "watch" ? "TV" : null, item: null,
        sources: [{ id: 53, name: "Bedroom TV", kind: "watch" }], items: [], temperature_modes: ["Heat", "Cool", "Auto"] })),
      available_rooms: [10, 11, 12, 13].filter((r) => !wakeRooms.some((w) => w.room === r)).map((r) => ctx.ref(r)),
      hospitality: false, lights: lights(ctx), blinds: [],
    } };
  }
  if (d.includes("emailnotification")) {
    return { id, view: "email_notification", title: "Email Notification", agent, data: {
      templates: emails.map((t) => ({ id: t.id, name: t.spec.name, subject: t.spec.subject, message: t.spec.body, to: t.spec.to, spec: { ...t.spec } })),
    } };
  }
  if (d.includes("agent_notification")) {
    const named = (l: { id: number; name: string }[], v: number) => l.find((x) => x.id === v)?.name ?? null;
    return { id, view: "push_notification", title: "Push Notification", agent, data: {
      templates: pushes.map((t) => ({ id: t.id, name: t.spec.name, subject: t.spec.subject, message: t.spec.message, timestamp: t.spec.timestamp,
        category: named(CATEGORIES, t.spec.category), severity: named(SEVERITIES, t.spec.severity),
        attachments: t.spec.attachments.map((a) => ctx.ref(a.owner)), spec: structuredClone(t.spec) })),
      categories: CATEGORIES, severities: SEVERITIES, attachment_providers: [],
    } };
  }
  return { id, view: null };
}

type OtherAgentOp = Extract<Op, { op:
  | "add_lighting_scene" | "rename_lighting_scene" | "remove_lighting_scene" | "set_scene_light" | "remove_scene_light"
  | "add_announcement" | "modify_announcement" | "remove_announcement"
  | "add_wake_sleep_room" | "modify_wake_sleep_room" | "remove_wake_sleep_room"
  | "add_push_notification" | "modify_push_notification" | "remove_push_notification"
  | "add_email_template" | "modify_email_template" | "remove_email_template" }>;

const OTHER = new Set<string>(["add_lighting_scene", "rename_lighting_scene", "remove_lighting_scene", "set_scene_light", "remove_scene_light",
  "add_announcement", "modify_announcement", "remove_announcement", "add_wake_sleep_room", "modify_wake_sleep_room", "remove_wake_sleep_room",
  "add_push_notification", "modify_push_notification", "remove_push_notification", "add_email_template", "modify_email_template", "remove_email_template"]);
export const isOtherAgentOp = (op: Op): op is OtherAgentOp => OTHER.has(op.op);

const sceneOf = (id: number) => {
  const s = scenes.find((x) => x.id === id);
  if (!s) throw `Advanced Lighting has no scene #${id}`;
  return s;
};
const byId = <T extends { id: number }>(list: T[], id: number, what: string) => {
  const x = list.find((y) => y.id === id);
  if (!x) throw `there is no ${what} #${id}`;
  return x;
};
const uniqueName = (names: string[], name: string, what: string) => {
  if (!name.trim()) throw "a name can't be empty";
  if (names.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase())) throw `there is already ${what} named “${name.trim()}”`;
};

export function describeAgentOp(op: OtherAgentOp, ctx: Ctx): string {
  const n = (id: number) => `“${ctx.ref(id).name}”`;
  switch (op.op) {
    case "add_lighting_scene": return `Add Advanced Lighting scene “${op.name}”`;
    case "rename_lighting_scene": return `Rename lighting scene “${sceneOf(op.scene).name}” to “${op.name}”`;
    case "remove_lighting_scene": return `Remove lighting scene “${sceneOf(op.scene).name}”`;
    case "set_scene_light": return `Set ${n(op.light)} in lighting scene “${sceneOf(op.scene).name}”: ${op.steps.map(stepText).join(" → ")}`;
    case "remove_scene_light": return `Remove ${n(op.light)} from lighting scene “${sceneOf(op.scene).name}”`;
    case "add_announcement": return `Add announcement “${op.announcement.name}”`;
    case "modify_announcement": return `Change announcement “${byId(announcements, op.id, "announcement").spec.name}”`;
    case "remove_announcement": return `Remove announcement “${byId(announcements, op.id, "announcement").spec.name}”`;
    case "add_wake_sleep_room": return `Set up Wake/Sleep in ${n(op.room)}`;
    case "modify_wake_sleep_room": return `Change the Wake/Sleep defaults of ${n(byId(wakeRooms, op.id, "Wake/Sleep room").room)}`;
    case "remove_wake_sleep_room": return `Remove Wake/Sleep from ${n(byId(wakeRooms, op.id, "Wake/Sleep room").room)}`;
    case "add_push_notification": return `Add push notification “${op.template.name}”`;
    case "modify_push_notification": return `Change push notification “${byId(pushes, op.id, "push notification").spec.name}”`;
    case "remove_push_notification": return `Remove push notification “${byId(pushes, op.id, "push notification").spec.name}”`;
    case "add_email_template": return `Add email notification “${op.template.name}”`;
    case "modify_email_template": return `Change email notification “${byId(emails, op.id, "email notification").spec.name}”`;
    case "remove_email_template": return `Remove email notification “${byId(emails, op.id, "email notification").spec.name}”`;
  }
}

/** The preview's diff for an agent op: whole records added/removed, a "settings" field changed. */
export function predictAgentOp(op: OtherAgentOp, ctx: Ctx): Change[] {
  const owner = ctx.itemRef(op.agent);
  const added = (what: string, id: number, name: string): Change => ({ kind: "agent_record_added", owner, what, id, name, details: [] });
  const removed = (what: string, id: number, name: string): Change => ({ kind: "agent_record_removed", owner, what, id, name, details: [], cascade: false });
  const changed = (what: string, id: number, name: string, field: string, from: string, to: string): Change =>
    ({ kind: "agent_record_changed", owner, what, id, name, field, from, to });
  switch (op.op) {
    case "add_lighting_scene":
      uniqueName(scenes.map((s) => s.name), op.name, "a lighting scene");
      return [added("lighting scene", lightingNext, op.name)];
    case "rename_lighting_scene": { const s = sceneOf(op.scene); return [changed("lighting scene", s.id, op.name, "name", s.name, op.name)]; }
    case "remove_lighting_scene": { const s = sceneOf(op.scene); return [removed("lighting scene", s.id, s.name)]; }
    case "set_scene_light": {
      const s = sceneOf(op.scene);
      const was = s.members.find((m) => m.device === op.light);
      return [changed("lighting scene", s.id, s.name, ctx.ref(op.light).name, was ? was.steps.map(stepText).join(" → ") : "none", op.steps.map(stepText).join(" → "))];
    }
    case "remove_scene_light": {
      const s = sceneOf(op.scene);
      const was = s.members.find((m) => m.device === op.light);
      if (!was) throw `#${op.light} isn't in scene “${s.name}”`;
      return [changed("lighting scene", s.id, s.name, ctx.ref(op.light).name, was.steps.map(stepText).join(" → "), "none")];
    }
    case "add_announcement":
      uniqueName(announcements.map((a) => a.spec.name), op.announcement.name, "an announcement");
      return [added("announcement", announceNext, op.announcement.name)];
    case "modify_announcement": {
      const a = byId(announcements, op.id, "announcement");
      return [changed("announcement", a.id, op.announcement.name, "settings", a.spec.text, op.announcement.text)];
    }
    case "remove_announcement": { const a = byId(announcements, op.id, "announcement"); return [removed("announcement", a.id, a.spec.name)]; }
    case "add_wake_sleep_room":
      if (wakeRooms.some((w) => w.room === op.room)) throw "that room already has Wake/Sleep";
      return [added("Wake/Sleep room", wakeNext, ctx.ref(op.room).name)];
    case "modify_wake_sleep_room": {
      const w = byId(wakeRooms, op.id, "Wake/Sleep room");
      return [changed("Wake/Sleep room", w.id, ctx.ref(w.room).name, "wake-up", w.settings.wake_time, op.settings.wake_time)];
    }
    case "remove_wake_sleep_room": { const w = byId(wakeRooms, op.id, "Wake/Sleep room"); return [removed("Wake/Sleep room", w.id, ctx.ref(w.room).name)]; }
    case "add_push_notification":
      uniqueName(pushes.map((t) => t.spec.name), op.template.name, "a push notification");
      return [added("push notification", pushNext, op.template.name)];
    case "modify_push_notification": {
      const t = byId(pushes, op.id, "push notification");
      return [changed("push notification", t.id, op.template.name, "title", t.spec.subject, op.template.subject)];
    }
    case "remove_push_notification": { const t = byId(pushes, op.id, "push notification"); return [removed("push notification", t.id, t.spec.name)]; }
    case "add_email_template":
      uniqueName(emails.map((t) => t.spec.name), op.template.name, "an email notification");
      return [added("email notification", emailNext, op.template.name)];
    case "modify_email_template": {
      const t = byId(emails, op.id, "email notification");
      return [changed("email notification", t.id, op.template.name, "subject", t.spec.subject, op.template.subject)];
    }
    case "remove_email_template": { const t = byId(emails, op.id, "email notification"); return [removed("email notification", t.id, t.spec.name)]; }
  }
}

export function applyAgentOp(op: OtherAgentOp, ctx: Ctx): void {
  const drop = <T extends { id: number }>(list: T[], id: number) => list.splice(list.findIndex((x) => x.id === id), 1);
  switch (op.op) {
    case "add_lighting_scene": scenes.push({ id: lightingNext++, name: op.name.trim(), members: [] }); return;
    case "rename_lighting_scene": sceneOf(op.scene).name = op.name.trim(); return;
    case "remove_lighting_scene": drop(scenes, op.scene); [0, 1, 4].forEach((e) => ctx.dropProgramming(LIGHTING, op.scene * 5 + e)); return;
    case "set_scene_light": {
      const s = sceneOf(op.scene);
      const m = s.members.find((x) => x.device === op.light);
      if (m) m.steps = op.steps;
      else s.members.push({ device: op.light, steps: op.steps });
      return;
    }
    case "remove_scene_light": { const s = sceneOf(op.scene); s.members = s.members.filter((m) => m.device !== op.light); return; }
    case "add_announcement": announcements.push({ id: announceNext++, spec: op.announcement }); return;
    case "modify_announcement": byId(announcements, op.id, "announcement").spec = op.announcement; return;
    case "remove_announcement": drop(announcements, op.id); ctx.dropProgramming(ANNOUNCE, op.id); return;
    case "add_wake_sleep_room": wakeRooms.push({ id: wakeNext++, room: op.room, settings: WAKE_DEFAULT() }); return;
    case "modify_wake_sleep_room": byId(wakeRooms, op.id, "Wake/Sleep room").settings = op.settings; return;
    case "remove_wake_sleep_room": drop(wakeRooms, op.id); return;
    case "add_push_notification": pushes.push({ id: pushNext++, spec: op.template }); return;
    case "modify_push_notification": byId(pushes, op.id, "push notification").spec = op.template; return;
    case "remove_push_notification": drop(pushes, op.id); return;
    case "add_email_template": emails.push({ id: emailNext++, spec: op.template }); return;
    case "modify_email_template": byId(emails, op.id, "email notification").spec = op.template; return;
    case "remove_email_template": drop(emails, op.id); return;
  }
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
