/** The Wake/Sleep agent's own tab, in place of Composer's Wake/Sleep editor: each room's
 *  defaults for the wake-ups and goodnights people set on touchscreens, a room per row with the
 *  picked one under the table. Rooms are set up,
 *  changed and removed as approvals (add/modify/remove_wake_sleep_room). */

import { createColumnHelper } from "@tanstack/react-table";
import { BellRing, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { NamedRef, WakeSleepData, WakeSleepRoomView, WakeSleepSpec, Weekday } from "../../../api";
import { DataTable } from "../../../components/DataTable";
import { Tip, useDialog } from "../../../components/Dialogs";
import { Select, Switch } from "../../../components/controls";
import type { Shell } from "../../../lib/shell";
import { cx, plural } from "../../../lib/ui";
import { AgentSplit, DetailPane, EditIcon, EditorCard, IconAct, Ref, RemoveIcon, refLabel, useWrites } from "./common";

const DAYS: { id: Weekday; short: string }[] = [
  { id: "sunday", short: "Sun" }, { id: "monday", short: "Mon" }, { id: "tuesday", short: "Tue" }, { id: "wednesday", short: "Wed" },
  { id: "thursday", short: "Thu" }, { id: "friday", short: "Fri" }, { id: "saturday", short: "Sat" },
];

const t12 = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const daysText = (d: Weekday[]) => (!d.length || d.length === 7 ? "every day" : DAYS.filter((x) => d.includes(x.id)).map((x) => x.short).join(", "));

function Part({ label, visible, enabled, children }: { label: string; visible: boolean; enabled: boolean; children?: React.ReactNode }) {
  return (
    <span className={cx("ag-part", visible && enabled && "on", !visible && "off")}
          title={!visible ? "Not offered on touchscreens" : enabled ? "On by default" : "Offered, off by default"}>
      {label}{visible && children ? <> · {children}</> : null}{!visible && <span className="dim"> · hidden</span>}
    </span>
  );
}

const col = createColumnHelper<WakeSleepRoomView>();

export function WakeSleepView({ agent, data, shell, onSelect, reload }: {
  agent: { id: number; name: string }; data: WakeSleepData; shell: Shell; onSelect: (id: number) => void; reload: () => void;
}) {
  const dialog = useDialog();
  const w = useWrites(shell, reload);
  const [picked, setPicked] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [room, setRoom] = useState("");
  const sel = data.rooms.find((r) => r.id === picked) ?? null;

  const remove = async (r: WakeSleepRoomView) => {
    const ok = await dialog.confirm({ title: `Remove Wake/Sleep from “${r.room.name}”?`, description: "Wake-ups and goodnights set there go with it.", confirmLabel: "Remove", danger: true });
    if (ok && await w.propose([{ op: "remove_wake_sleep_room", agent: agent.id, id: r.id }], `Remove Wake/Sleep from “${r.room.name}”.`)) setPicked(null);
  };

  const columns = useMemo(() => [
    col.accessor((r) => r.room.name, { id: "room", header: "Room", cell: (c) => <span className="ellip">{c.getValue()}</span> }),
    col.accessor((r) => r.settings.wake_time, { id: "wake", header: "Wake", meta: { width: 84 }, cell: (c) => t12(c.getValue()) }),
    col.accessor((r) => daysText(r.settings.wake_days), { id: "days", header: "Days", meta: { width: "26%", hideBelow: 420 }, cell: (c) => <span className="ellip dim">{c.getValue()}</span> }),
    col.accessor((r) => r.settings.sleep_minutes, { id: "fade", header: "Goodnight", meta: { width: 92, align: "right", hideBelow: 340 }, cell: (c) => `${c.getValue()} min` }),
    col.accessor((r) => ["lights", "media", "blinds", "temperature"].filter((k) => r.settings[k as "lights"].visible).length, {
      id: "parts", header: "Offers", meta: { width: "24%", hideBelow: 520 },
      cell: (c) => { const st = c.row.original.settings; return <span className="ellip dim">{(["lights", "media", "blinds", "temperature"] as const).filter((k) => st[k].visible).join(", ") || "—"}</span>; },
    }),
  ], []);

  const detail = sel && (editing ? (
    <RoomEditor key={sel.id} r={sel} data={data} busy={w.busy} onCancel={() => setEditing(false)}
      onSave={async (settings) => {
        if (await w.propose([{ op: "modify_wake_sleep_room", agent: agent.id, id: sel.id, settings }], `Change the Wake/Sleep defaults of “${sel.room.name}”.`)) setEditing(false);
      }} />
  ) : (
    <DetailPane icon={<BellRing size={14} strokeWidth={1.8} />} title={<Ref r={{ ...sel.room, room: null }} onSelect={onSelect} />}
      actions={<>
        <IconAct label="Edit" why={w.why} disabled={w.busy} onClick={() => setEditing(true)}><EditIcon /></IconAct>
        <IconAct label="Remove" why={w.why} disabled={w.busy} danger onClick={() => remove(sel)}><RemoveIcon /></IconAct>
      </>}>
      <dl className="ag-dl">
        <dt>Wake up</dt><dd><b>{t12(sel.settings.wake_time)}</b> <span className="dim">{daysText(sel.settings.wake_days)}</span></dd>
        <dt>Goodnight</dt><dd>fades over <b>{sel.settings.sleep_minutes} min</b></dd>
      </dl>
      <div className="ag-parts">
        <Part label="Lights" visible={sel.settings.lights.visible} enabled={sel.settings.lights.enabled}>
          <Ref r={sel.light} onSelect={onSelect} /> <span className="dim">over {sel.settings.lights.ramp_minutes} min</span>
        </Part>
        <Part label="Media" visible={sel.settings.media.visible} enabled={sel.settings.media.enabled}>
          {sel.source ?? <span className="dim">no source</span>}{sel.item && <span className="dim"> · {sel.item}</span>}
        </Part>
        <Part label="Blinds" visible={sel.settings.blinds.visible} enabled={sel.settings.blinds.enabled}><Ref r={sel.blind} onSelect={onSelect} /></Part>
        <Part label="Temperature" visible={sel.settings.temperature.visible} enabled={sel.settings.temperature.enabled}>
          {[sel.settings.temperature.mode, `${sel.settings.temperature.setpoint_f}°F`].filter(Boolean).join(" ")}
        </Part>
      </div>
    </DetailPane>
  ));

  return (
    <AgentSplit id="wake-sleep" detail={detail} bar={<>
      <span className="dim small">{plural(data.rooms.length, "room")}{data.hospitality ? " · hospitality mode" : ""}</span>
      <span className="spread" />
      {!!data.available_rooms.length && <>
        <Select<string> value={room} label="Room to set up" placeholder="Set up a room…"
          options={data.available_rooms.map((r) => ({ value: String(r.id), label: r.name }))} onValueChange={setRoom} disabled={!w.can} />
        <Tip text={w.why ?? "Set up Wake/Sleep in the room, with Composer's defaults"}>
          <span><button className="act small primary" disabled={!w.can || !room} onClick={async () => {
            const r = data.available_rooms.find((x) => String(x.id) === room);
            if (r && await w.propose([{ op: "add_wake_sleep_room", agent: agent.id, room: r.id }], `Set up Wake/Sleep in “${r.name}”.`)) setRoom("");
          }}><Plus size={13} strokeWidth={2} />Add</button></span>
        </Tip>
      </>}
    </>}>
      <DataTable data={data.rooms} columns={columns} rowId={(r) => String(r.id)} label="Wake/Sleep rooms" sort={[{ id: "room", desc: false }]}
        selected={sel ? String(sel.id) : null} onSelect={(r) => { if (r.id !== picked) setEditing(false); setPicked(r.id); }}
        onActivate={(r) => { setPicked(r.id); if (w.can) setEditing(true); }}
        empty={<p className="empty">No rooms are set up for Wake/Sleep.</p>} />
    </AgentSplit>
  );
}

/** One "visible / on by default" pair, as Composer's checkboxes. */
function Shown({ v, e, set }: { v: boolean; e: boolean; set: (p: { visible?: boolean; enabled?: boolean }) => void }) {
  return (
    <>
      <label className="ag-switch"><Switch checked={v} onCheckedChange={(visible) => set({ visible })} label="Offered on touchscreens" /><span>Offered</span></label>
      <label className="ag-switch"><Switch checked={e} onCheckedChange={(enabled) => set({ enabled })} label="On by default" /><span>On by default</span></label>
    </>
  );
}

const pickOptions = (all: string, list: NamedRef[], current: number) => {
  const opts = [{ value: "0", label: all }, ...list.map((l) => ({ value: String(l.id), label: refLabel(l) }))];
  if (current && !list.some((l) => l.id === current)) opts.push({ value: String(current), label: `#${current}` });
  return opts;
};

function RoomEditor({ r, data, busy, onCancel, onSave }: {
  r: WakeSleepRoomView; data: WakeSleepData; busy: boolean; onCancel: () => void; onSave: (s: WakeSleepSpec) => void;
}) {
  const [s, setS] = useState<WakeSleepSpec>(() => structuredClone(r.settings));
  const set = <K extends "lights" | "media" | "blinds" | "temperature">(k: K, patch: Partial<WakeSleepSpec[K]>) =>
    setS((x) => ({ ...x, [k]: { ...x[k], ...patch } }));
  // The room's own lights first: those are what someone setting a wake-up there expects.
  const lights = [...data.lights].sort((a, b) => Number(b.room === r.room.name) - Number(a.room === r.room.name));
  const sources = r.sources.length ? r.sources : [];
  const problem = (() => {
    if (!/^\d{2}:\d{2}$/.test(s.wake_time)) return "Pick a wake-up time.";
    if (s.sleep_minutes < 0 || s.sleep_minutes > 240) return "The goodnight fade is 0–240 minutes.";
    if (s.lights.ramp_minutes < 0 || s.lights.ramp_minutes > 240) return "The lights' ramp is 0–240 minutes.";
    if (s.temperature.setpoint_f < 40 || s.temperature.setpoint_f > 99) return "The setpoint is 40–99 °F.";
    return null;
  })();
  const sourceValue = s.media.source ? String(s.media.source) : s.media.kind === "watch" || s.media.tv_only ? "tv" : "none";

  return (
    <EditorCard icon={<BellRing size={15} strokeWidth={1.8} />} title={`Wake/Sleep in ${r.room.name}`} problem={problem} busy={busy}
      saveLabel="Save changes" onCancel={onCancel} onSave={() => onSave(s)}>
      <label>Wake up</label>
      <div className="ag-row">
        <input type="time" value={s.wake_time} onChange={(e) => setS((x) => ({ ...x, wake_time: e.target.value }))} />
        {!data.hospitality && (
          <div className="ag-days" role="group" aria-label="Days">
            {DAYS.map((d) => {
              const all = !s.wake_days.length;
              const on = all || s.wake_days.includes(d.id);
              return <button type="button" key={d.id} aria-pressed={on} className={cx(on && "on")} onClick={() => {
                const cur = all ? DAYS.map((x) => x.id) : s.wake_days;
                const next = on ? cur.filter((x) => x !== d.id) : [...cur, d.id];
                setS((x) => ({ ...x, wake_days: next.length === 7 ? [] : next }));
              }}>{d.short}</button>;
            })}
          </div>
        )}
      </div>

      <label>Goodnight</label>
      <div className="ag-row">
        <span className="dim small">fade over</span>
        <input className="narrow" type="number" min={0} max={240} value={s.sleep_minutes} onChange={(e) => setS((x) => ({ ...x, sleep_minutes: Number(e.target.value) || 0 }))} />
        <span className="dim small">min</span>
      </div>

      <label>Lights</label>
      <div className="ag-row">
        <Shown v={s.lights.visible} e={s.lights.enabled} set={(p) => set("lights", p)} />
        <Select<string> value={String(s.lights.light)} label="Light" options={pickOptions("All lights in the room", lights, s.lights.light)}
          onValueChange={(v) => set("lights", { light: Number(v) })} />
        <span className="dim small">up over</span>
        <input className="narrow" type="number" min={0} max={240} value={s.lights.ramp_minutes} onChange={(e) => set("lights", { ramp_minutes: Number(e.target.value) || 0 })} />
        <span className="dim small">min</span>
      </div>

      <label>Media</label>
      <div className="ag-row">
        <Shown v={s.media.visible} e={s.media.enabled} set={(p) => set("media", p)} />
        <Select<string> value={sourceValue} label="Source"
          options={[
            { value: "none", label: "No source" },
            { value: "tv", label: "TV" },
            ...sources.map((x) => ({ value: String(x.id), label: `${x.name}${x.kind ? ` (${x.kind})` : ""}` })),
            ...(s.media.source && !sources.some((x) => x.id === s.media.source) ? [{ value: String(s.media.source), label: r.source ?? `#${s.media.source}` }] : []),
          ]}
          onValueChange={(v) => {
            if (v === "none") set("media", { source: 0, kind: "", item: 0, tv_only: false });
            else if (v === "tv") set("media", { source: 0, kind: "watch", item: 0, tv_only: true });
            else {
              const src = sources.find((x) => String(x.id) === v);
              set("media", { source: Number(v), kind: src?.kind ?? s.media.kind, item: 0, tv_only: false });
            }
          }} />
        {!!r.items.length && s.media.source === r.settings.media.source && (
          <Select<string> value={String(s.media.item)} label="Item"
            options={[{ value: "0", label: "No item" }, ...r.items.map((x) => ({ value: String(x.id), label: x.name }))]}
            onValueChange={(v) => set("media", { item: Number(v) })} />
        )}
        {!r.items.length && !!s.media.item && <span className="dim small">{r.item}</span>}
      </div>

      <label>Blinds</label>
      <div className="ag-row">
        <Shown v={s.blinds.visible} e={s.blinds.enabled} set={(p) => set("blinds", p)} />
        <Select<string> value={String(s.blinds.blind)} label="Blind" options={pickOptions("All blinds in the room", data.blinds, s.blinds.blind)}
          onValueChange={(v) => set("blinds", { blind: Number(v) })} />
      </div>

      {(data.hospitality || s.temperature.visible) && <>
        <label>Temperature</label>
        <div className="ag-row">
          <Shown v={s.temperature.visible} e={s.temperature.enabled} set={(p) => set("temperature", p)} />
          {r.temperature_modes.length
            ? <Select<string> value={s.temperature.mode} label="Mode" options={[...new Set([...r.temperature_modes, s.temperature.mode].filter(Boolean))].map((m) => ({ value: m, label: m }))}
                onValueChange={(mode) => set("temperature", { mode })} />
            : <input className="narrow wide" value={s.temperature.mode} placeholder="Mode" onChange={(e) => set("temperature", { mode: e.target.value })} />}
          <input className="narrow" type="number" min={40} max={99} value={s.temperature.setpoint_f} onChange={(e) => set("temperature", { setpoint_f: Number(e.target.value) || 0 })} />
          <span className="dim small">°F</span>
        </div>
      </>}
    </EditorCard>
  );
}
