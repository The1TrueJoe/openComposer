/** The Announcements agent's own tab, in place of Composer's Announcements editor: what each
 *  announcement plays and shows, and where. Added, changed and removed as approvals
 *  (add/modify/remove_announcement). Camera logins in image URLs stay masked here and are
 *  kept by the backend when the masked URL comes back unchanged. */

import { Image, Megaphone, Monitor, Music, Pencil, Plus, Trash2, Volume2 } from "lucide-react";
import { useState } from "react";
import type { AnnouncementSpec, AnnouncementView, AnnouncementsData, AnnouncementVolume, NamedRef } from "../../../api";
import { Tip, useDialog } from "../../../components/Dialogs";
import { Select, Switch } from "../../../components/controls";
import type { Shell } from "../../../lib/shell";
import { plural } from "../../../lib/ui";
import { EditorCard, MultiPick, Ref, RemoveChip, VolumeInput, refLabel, useWrites } from "./common";

const MASK = "••••";

const BLANK = (): AnnouncementSpec => ({
  name: "", audio: null, text: "", image: null, display_seconds: 30, ok_button: true, rooms: [], screens: [], touchscreen_audio: [],
});

const secondsLabel = (s: number) => (s >= 60 ? `${s / 60} minute${s === 60 ? "" : "s"}` : `${s} seconds`);

export function AnnouncementsView({ agent, data, shell, onSelect, reload }: {
  agent: { id: number; name: string }; data: AnnouncementsData; shell: Shell; onSelect: (id: number) => void; reload: () => void;
}) {
  const dialog = useDialog();
  const w = useWrites(shell, reload);
  const [editing, setEditing] = useState<AnnouncementView | "new" | null>(null);

  const remove = async (a: AnnouncementView) => {
    const ok = await dialog.confirm({
      title: `Remove “${a.name}”?`,
      description: a.programmed ? `Its programming (${plural(a.programmed, "line")}) goes with it.` : undefined,
      confirmLabel: "Remove", danger: true,
    });
    if (ok) await w.propose([{ op: "remove_announcement", agent: agent.id, id: a.id }], `Remove the announcement “${a.name}”.`);
  };

  return (
    <div className="ag">
      <div className="ag-bar">
        <span className="dim small">{plural(data.announcements.length, "announcement")}</span>
        <span className="spread" />
        <Tip text={w.why ?? "Add an announcement"}>
          <span><button className="act small primary" disabled={!w.can} onClick={() => setEditing("new")}><Plus size={13} strokeWidth={2} />Add announcement</button></span>
        </Tip>
      </div>
      {editing && (
        <AnnouncementEditor key={editing === "new" ? "new" : editing.id} a={editing === "new" ? null : editing} data={data} busy={w.busy}
          onCancel={() => setEditing(null)}
          onSave={async (spec) => {
            const ok = editing === "new"
              ? await w.propose([{ op: "add_announcement", agent: agent.id, announcement: spec }], `Add the announcement “${spec.name}”.`)
              : await w.propose([{ op: "modify_announcement", agent: agent.id, id: editing.id, announcement: spec }], `Change the announcement “${editing.name}”.`);
            if (ok) setEditing(null);
          }} />
      )}
      {!data.announcements.length && !editing && <p className="empty pad">No announcements yet.</p>}
      {data.announcements.map((a) => (
        <div key={a.id} className="ag-card">
          <div className="ag-card-head">
            <Megaphone size={14} strokeWidth={1.8} />
            <b>{a.name}</b>
            <span className="dim mono small">#{a.id}</span>
            {!!a.programmed && <span className="tag accent">{plural(a.programmed, "programming line")}</span>}
            <span className="spread" />
            <Tip text={w.why ?? "Edit"}>
              <span><button className="icon-btn" aria-label="Edit" disabled={!w.can} onClick={() => setEditing(a)}><Pencil size={13} strokeWidth={1.8} /></button></span>
            </Tip>
            <Tip text={w.why ?? "Remove"}>
              <span><button className="icon-btn danger" aria-label="Remove" disabled={!w.can} onClick={() => remove(a)}><Trash2 size={13} strokeWidth={1.8} /></button></span>
            </Tip>
          </div>
          <dl className="ag-dl">
            {a.audio && <><dt><Music size={12} strokeWidth={1.8} />Sound</dt><dd className="mono">{a.audio}</dd></>}
            {a.text && <><dt><Monitor size={12} strokeWidth={1.8} />Text</dt><dd>“{a.text}”</dd></>}
            {a.image && <><dt><Image size={12} strokeWidth={1.8} />Image</dt><dd className="mono ag-url">{a.image}</dd></>}
            {(a.text || a.image) && <><dt>On screen</dt><dd>{secondsLabel(a.display_seconds)}{a.ok_button ? ", with an OK button" : ""}</dd></>}
            {!!a.rooms.length && <><dt><Volume2 size={12} strokeWidth={1.8} />Plays in</dt>
              <dd className="ag-refs">{a.rooms.map((r) => <span key={r.room.id}><Ref r={r.room} onSelect={onSelect} />{r.volume != null && <span className="dim small"> {r.volume}%</span>}</span>)}</dd></>}
            {!!a.screens.length && <><dt><Monitor size={12} strokeWidth={1.8} />Shows on</dt>
              <dd className="ag-refs">{a.screens.map((s) => <Ref key={s.device.id} r={s.device} onSelect={onSelect} />)}</dd></>}
            {!!a.touchscreen_audio.length && <><dt><Volume2 size={12} strokeWidth={1.8} />Screen sound</dt>
              <dd className="ag-refs">{a.touchscreen_audio.map((t) => <span key={t.device.id}><Ref r={t.device} onSelect={onSelect} />{t.volume != null && <span className="dim small"> {t.volume}%</span>}</span>)}</dd></>}
          </dl>
        </div>
      ))}
    </div>
  );
}

/** Rooms or touchscreens with a volume each: chips to pick, then a volume per pick. */
function Volumes({ options, value, onChange, empty }: {
  options: NamedRef[]; value: AnnouncementVolume[]; onChange: (v: AnnouncementVolume[]) => void; empty: string;
}) {
  const name = (id: number) => options.find((o) => o.id === id) ?? { id, name: `#${id}`, room: null };
  return (
    <div className="ag-stack">
      <MultiPick options={options} value={value.map((v) => v.id)} empty={empty}
        onChange={(ids) => onChange(ids.map((id) => value.find((v) => v.id === id) ?? { id, volume: null }))} />
      {value.map((v) => (
        <div key={v.id} className="ag-row">
          <span className="ag-vol-name">{refLabel(name(v.id))}</span>
          <VolumeInput label={name(v.id).name} value={v.volume} onChange={(volume) => onChange(value.map((x) => (x.id === v.id ? { ...x, volume } : x)))} />
          <RemoveChip label={`Remove ${name(v.id).name}`} onClick={() => onChange(value.filter((x) => x.id !== v.id))} />
        </div>
      ))}
    </div>
  );
}

function AnnouncementEditor({ a, data, busy, onCancel, onSave }: {
  a: AnnouncementView | null; data: AnnouncementsData; busy: boolean; onCancel: () => void; onSave: (s: AnnouncementSpec) => void;
}) {
  const [s, setS] = useState<AnnouncementSpec>(() => (a ? structuredClone(a.spec) : BLANK()));
  const set = (patch: Partial<AnnouncementSpec>) => setS((x) => ({ ...x, ...patch }));
  const taken = data.announcements.filter((x) => x.id !== a?.id).map((x) => x.name.trim().toLowerCase());
  const problem = (() => {
    if (!s.name.trim()) return "Give it a name.";
    if (taken.includes(s.name.trim().toLowerCase())) return "Another announcement has that name.";
    if (!a && [s.image, s.audio].some((v) => v?.includes(MASK))) return `A new announcement's image can't contain “${MASK}”.`;
    if (s.audio === "" || s.image === "") return "Leave the sound or image off rather than empty.";
    return null;
  })();
  const clean = (): AnnouncementSpec => ({ ...s, name: s.name.trim(), audio: s.audio?.trim() || null, image: s.image?.trim() || null });
  const masked = !!a?.spec.image?.includes(MASK);

  return (
    <EditorCard icon={<Megaphone size={15} strokeWidth={1.8} />} title={a ? `Edit “${a.name}”` : "New announcement"} problem={problem} busy={busy}
      saveLabel={a ? "Save changes" : "Add announcement"} onCancel={onCancel} onSave={() => onSave(clean())}>
      <label>Name</label>
      <input autoFocus value={s.name} placeholder="e.g. Doorbell" onChange={(e) => set({ name: e.target.value })} />

      <label>Sound</label>
      <div className="ag-row">
        <label className="ag-check"><input type="checkbox" checked={s.audio != null} onChange={(e) => set({ audio: e.target.checked ? data.sounds[0] ?? "" : null })} />Play a sound</label>
        {s.audio != null && <>
          <input list="ag-sounds" value={s.audio} placeholder="bell.mp3 or https://…" onChange={(e) => set({ audio: e.target.value })} />
          <datalist id="ag-sounds">{data.sounds.map((f) => <option key={f} value={f} />)}</datalist>
        </>}
      </div>
      {s.audio != null && <>
        <label>Plays in</label>
        <Volumes options={data.rooms} value={s.rooms} onChange={(rooms) => set({ rooms })} empty="No rooms" />
        <label>Screen sound</label>
        <Volumes options={data.touchscreens} value={s.touchscreen_audio} onChange={(touchscreen_audio) => set({ touchscreen_audio })} empty="No touchscreens in the project" />
      </>}

      <label>Text</label>
      <input value={s.text} placeholder="Shown on screens" onChange={(e) => set({ text: e.target.value })} />

      <label>Image</label>
      <div className="ag-stack">
        <div className="ag-row">
          <label className="ag-check"><input type="checkbox" checked={s.image != null} onChange={(e) => set({ image: e.target.checked ? a?.spec.image ?? "" : null })} />Show an image</label>
          {s.image != null && <input className="ag-wide" value={s.image} placeholder="http://camera/snapshot.jpg" onChange={(e) => set({ image: e.target.value })} />}
        </div>
        {masked && s.image?.includes(MASK) && <span className="dim small">The camera's login is hidden ({MASK}) and kept as it is.</span>}
      </div>

      <label>Shows on</label>
      <MultiPick options={data.screens} value={s.screens} onChange={(screens) => set({ screens })} empty="No controllers or touchscreens in the project" />

      <label>On screen</label>
      <div className="ag-row">
        <Select<string> value={String(s.display_seconds)} label="How long it stays on screen"
          options={data.display_seconds.map((n) => ({ value: String(n), label: secondsLabel(n) }))}
          onValueChange={(v) => set({ display_seconds: Number(v) })} />
        <label className="ag-switch"><Switch checked={s.ok_button} onCheckedChange={(ok_button) => set({ ok_button })} label="OK button" /><span>OK button</span></label>
      </div>
    </EditorCard>
  );
}
