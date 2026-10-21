/** Read-only tabs for the other built-in agents Composer edits with its own plugins:
 *  Advanced Lighting scenes, Announcements, Wake/Sleep rooms, notification templates.
 *  Changing them isn't supported yet; Composer still does that. */

import { Bell, BellRing, Image, Lightbulb, Mail, Megaphone, Monitor, Music, Volume2 } from "lucide-react";
import type { AnnouncementView, LightingSceneView, NamedRef, NotificationTemplateView, WakeSleepPartView, WakeSleepRoomView } from "../../../api";
import { cx, plural } from "../../../lib/ui";

const Ref = ({ r, onSelect }: { r: NamedRef; onSelect: (id: number) => void }) => (
  <button className="ag-ref" onClick={() => onSelect(r.id)} title={r.room ? `${r.name} in ${r.room}` : r.name}>
    {r.name}{r.room && r.room !== r.name && <span className="dim"> · {r.room}</span>}
  </button>
);

const ReadOnlyNote = ({ what }: { what: string }) => <p className="ag-note dim small">Shown as Composer has it. Editing {what} here isn't supported yet.</p>;

const ms = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(1)} s` : `${n} ms`);

export function LightingView({ scenes, onSelect }: { scenes: LightingSceneView[]; onSelect: (id: number) => void }) {
  if (!scenes.length) return <p className="empty pad">No Advanced Lighting scenes.</p>;
  return (
    <div className="ag">
      <ReadOnlyNote what="scenes" />
      {scenes.map((s) => (
        <div key={s.id} className="ag-card">
          <div className="ag-card-head">
            <Lightbulb size={14} strokeWidth={1.8} />
            <b>{s.name}</b>
            <span className="dim mono small">#{s.id}</span>
            {s.active && <span className="tag on">active</span>}
            <span className="spread dim small">{plural(s.members.length, "light")}</span>
          </div>
          {!!s.members.length && (
            <table className="ag-table">
              <tbody>
                {s.members.map((m) => (
                  <tr key={m.device.id}>
                    <td><Ref r={m.device} onSelect={onSelect} /></td>
                    <td>
                      {m.steps.map((st, i) => (
                        <span key={i} className="ag-step">
                          {st.delay_ms > 0 && <span className="dim">after {ms(st.delay_ms)} · </span>}
                          {st.level != null && <b>{st.level}%</b>}
                          {st.color_temperature != null && <span className="ag-swatch" style={{ background: kelvinCss(st.color_temperature) }} title={`${st.color_temperature} K`} />}
                          {st.color_hs && <span className="ag-swatch" style={{ background: `hsl(${st.color_hs[0]} ${st.color_hs[1]}% 50%)` }} title={`hue ${st.color_hs[0]}°, saturation ${st.color_hs[1]}%`} />}
                          {st.color_temperature != null && <span className="dim">{st.color_temperature} K</span>}
                          <span className="dim"> over {ms(st.rate_ms)}</span>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

/** A rough white for a colour temperature, for the swatch only. */
function kelvinCss(k: number): string {
  const t = Math.min(1, Math.max(0, (k - 2000) / 4500));
  return `color-mix(in srgb, #ffb46b ${Math.round((1 - t) * 100)}%, #dfe8ff)`;
}

export function AnnouncementsView({ list, onSelect }: { list: AnnouncementView[]; onSelect: (id: number) => void }) {
  if (!list.length) return <p className="empty pad">No announcements.</p>;
  return (
    <div className="ag">
      <ReadOnlyNote what="announcements" />
      {list.map((a) => (
        <div key={a.id} className="ag-card">
          <div className="ag-card-head">
            <Megaphone size={14} strokeWidth={1.8} />
            <b>{a.name}</b>
            <span className="dim mono small">#{a.id}</span>
          </div>
          <dl className="ag-dl">
            {a.audio && <><dt><Music size={12} strokeWidth={1.8} />Sound</dt><dd className="mono">{a.audio}</dd></>}
            {a.text && <><dt><Monitor size={12} strokeWidth={1.8} />Text</dt><dd>“{a.text}”</dd></>}
            {a.image && <><dt><Image size={12} strokeWidth={1.8} />Image</dt><dd className="mono ag-url">{a.image}</dd></>}
            {!!a.rooms.length && <><dt><Volume2 size={12} strokeWidth={1.8} />Plays in</dt>
              <dd className="ag-refs">{a.rooms.map((r) => <span key={r.room.id}><Ref r={r.room} onSelect={onSelect} />{r.volume != null && <span className="dim small"> {r.volume}%</span>}</span>)}</dd></>}
            {!!a.screens.length && <><dt><Monitor size={12} strokeWidth={1.8} />Screens</dt>
              <dd className="ag-refs">{a.screens.map((s) => <span key={s.device.id}><Ref r={s.device} onSelect={onSelect} />{s.onscreen === false && <span className="dim small"> (sound only)</span>}</span>)}</dd></>}
          </dl>
        </div>
      ))}
    </div>
  );
}

const DAYS_ALL = (d: string) => (d === "all" ? "every day" : d);

function Part({ label, p, onSelect }: { label: string; p: WakeSleepPartView | null; onSelect: (id: number) => void }) {
  if (!p) return null;
  return (
    <span className={cx("ag-part", p.enabled && "on")} title={p.enabled ? "On by default" : "Available, off by default"}>
      {label}{p.device && <> · <Ref r={p.device} onSelect={onSelect} /></>}{p.detail && <span className="dim"> · {p.detail}</span>}
    </span>
  );
}

export function WakeSleepView({ rooms, onSelect }: { rooms: WakeSleepRoomView[]; onSelect: (id: number) => void }) {
  if (!rooms.length) return <p className="empty pad">No rooms are set up for Wake/Sleep.</p>;
  const t12 = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };
  return (
    <div className="ag">
      <ReadOnlyNote what="Wake/Sleep" />
      {rooms.map((r) => (
        <div key={r.id} className="ag-card">
          <div className="ag-card-head">
            <BellRing size={14} strokeWidth={1.8} />
            <Ref r={{ ...r.room, room: null }} onSelect={onSelect} />
            <span className="spread small">wake <b>{t12(r.wake_time)}</b> <span className="dim">{DAYS_ALL(r.wake_days)}</span> · sleep fade <b>{r.sleep_minutes} min</b></span>
          </div>
          <div className="ag-parts">
            <Part label="Lights" p={r.lights} onSelect={onSelect} />
            <Part label="Media" p={r.media} onSelect={onSelect} />
            <Part label="Blinds" p={r.blinds} onSelect={onSelect} />
            <Part label="Temperature" p={r.temperature} onSelect={onSelect} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TemplatesView({ kind, templates, onSelect }: { kind: "push" | "email"; templates: NotificationTemplateView[]; onSelect: (id: number) => void }) {
  if (!templates.length) return <p className="empty pad">No {kind === "push" ? "push notifications" : "email templates"} set up.</p>;
  const Icon = kind === "push" ? Bell : Mail;
  return (
    <div className="ag">
      <ReadOnlyNote what={kind === "push" ? "notifications" : "email templates"} />
      {templates.map((t) => (
        <div key={t.id} className="ag-card">
          <div className="ag-card-head">
            <Icon size={14} strokeWidth={1.8} />
            <b>{t.name}</b>
            <span className="dim mono small">#{t.id}</span>
            {t.severity && <span className={cx("tag", t.severity === "Alarms" && "warn")}>{t.severity}</span>}
            {t.category && <span className="tag">{t.category}</span>}
          </div>
          {(t.subject || t.message || t.attachments?.length) ? (
            <dl className="ag-dl">
              {t.subject && <><dt>Title</dt><dd>{t.subject}</dd></>}
              {t.message && <><dt>Message</dt><dd>{t.message}</dd></>}
              {!!t.attachments?.length && <><dt>Snapshot</dt><dd className="ag-refs">{t.attachments.map((a, i) => <Ref key={i} r={a} onSelect={onSelect} />)}</dd></>}
            </dl>
          ) : null}
        </div>
      ))}
    </div>
  );
}
