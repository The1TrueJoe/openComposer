/** The Push Notification and Email Notification agents' own tabs, in place of Composer's
 *  editors: the messages programming can send. Added, changed and removed as approvals
 *  (*_push_notification, *_email_template). */

import { Bell, Camera, Mail, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { EmailData, EmailTemplateSpec, EmailTemplateView, NamedRef, PushData, PushTemplateSpec, PushTemplateView } from "../../../api";
import { Tip, useDialog } from "../../../components/Dialogs";
import { Select, Switch } from "../../../components/controls";
import type { Shell } from "../../../lib/shell";
import { cx, plural } from "../../../lib/ui";
import { EditorCard, Ref, refLabel, useWrites } from "./common";

type Agent = { id: number; name: string };

function List<T extends { id: number; name: string }>({ kind, items, w, onEdit, onRemove, onAdd, editor, children }: {
  kind: string; items: T[]; w: ReturnType<typeof useWrites>; onEdit: (t: T) => void; onRemove: (t: T) => void; onAdd: () => void;
  /** The open editor, shown under the bar. */
  editor: React.ReactNode; children: (t: T) => React.ReactNode;
}) {
  return (
    <>
      <div className="ag-bar">
        <span className="dim small">{plural(items.length, kind)}</span>
        <span className="spread" />
        <Tip text={w.why ?? `Add a ${kind}`}>
          <span><button className="act small primary" disabled={!w.can} onClick={onAdd}><Plus size={13} strokeWidth={2} />Add</button></span>
        </Tip>
      </div>
      {editor}
      {items.map((t) => (
        <div key={t.id} className="ag-card">
          <div className="ag-card-head">
            {kind.startsWith("push") ? <Bell size={14} strokeWidth={1.8} /> : <Mail size={14} strokeWidth={1.8} />}
            <b>{t.name}</b>
            <span className="dim mono small">#{t.id}</span>
            {children(t)}
            <span className="spread" />
            <Tip text={w.why ?? "Edit"}>
              <span><button className="icon-btn" aria-label="Edit" disabled={!w.can} onClick={() => onEdit(t)}><Pencil size={13} strokeWidth={1.8} /></button></span>
            </Tip>
            <Tip text={w.why ?? "Remove"}>
              <span><button className="icon-btn danger" aria-label="Remove" disabled={!w.can} onClick={() => onRemove(t)}><Trash2 size={13} strokeWidth={1.8} /></button></span>
            </Tip>
          </div>
        </div>
      ))}
    </>
  );
}

export function PushView({ agent, data, shell, onSelect, reload }: { agent: Agent; data: PushData; shell: Shell; onSelect: (id: number) => void; reload: () => void }) {
  const dialog = useDialog();
  const w = useWrites(shell, reload);
  const [editing, setEditing] = useState<PushTemplateView | "new" | null>(null);
  const remove = async (t: PushTemplateView) => {
    if (await dialog.confirm({ title: `Remove “${t.name}”?`, description: "Programming that sends it will send nothing.", confirmLabel: "Remove", danger: true })) {
      await w.propose([{ op: "remove_push_notification", agent: agent.id, id: t.id }], `Remove the push notification “${t.name}”.`);
    }
  };
  return (
    <div className="ag">
      <List kind="push notification" items={data.templates} w={w} onAdd={() => setEditing("new")} onEdit={setEditing} onRemove={remove}
        editor={editing && (
        <PushEditor key={editing === "new" ? "new" : editing.id} t={editing === "new" ? null : editing} data={data} busy={w.busy} onCancel={() => setEditing(null)}
          onSave={async (template) => {
            const ok = editing === "new"
              ? await w.propose([{ op: "add_push_notification", agent: agent.id, template }], `Add the push notification “${template.name}”.`)
              : await w.propose([{ op: "modify_push_notification", agent: agent.id, id: editing.id, template }], `Change the push notification “${editing.name}”.`);
            if (ok) setEditing(null);
          }} />
        )}>
        {(t) => <>
          {t.severity && <span className={cx("tag", t.severity === "Alarms" && "warn")}>{t.severity}</span>}
          {t.category && <span className="tag">{t.category}</span>}
          <span className="ag-line dim small">{t.subject}{t.message ? ` — ${t.message}` : ""}</span>
          {t.attachments.map((a, i) => <span key={i} className="small ag-snap"><Camera size={12} strokeWidth={1.8} /><Ref r={a} onSelect={onSelect} /></span>)}
        </>}
      </List>
      {!data.templates.length && !editing && <p className="empty pad">No push notifications set up.</p>}
    </div>
  );
}

function PushEditor({ t, data, busy, onCancel, onSave }: {
  t: PushTemplateView | null; data: PushData; busy: boolean; onCancel: () => void; onSave: (s: PushTemplateSpec) => void;
}) {
  const [s, setS] = useState<PushTemplateSpec>(() => (t ? structuredClone(t.spec) : { name: "", category: 0, severity: 0, subject: "", message: "", timestamp: true, attachments: [] }));
  const set = (p: Partial<PushTemplateSpec>) => setS((x) => ({ ...x, ...p }));
  const taken = data.templates.filter((x) => x.id !== t?.id).map((x) => x.name.trim().toLowerCase());
  const problem = !s.name.trim() ? "Give it a name." : taken.includes(s.name.trim().toLowerCase()) ? "Another notification has that name." : null;
  const named = (owner: number): NamedRef => data.attachment_providers.find((p) => p.owner.id === owner)?.owner ?? { id: owner, name: `#${owner}`, room: null };
  const pick = (l: { id: number; name: string }[], none: string) => [{ value: "0", label: none }, ...l.map((x) => ({ value: String(x.id), label: x.name }))];
  return (
    <EditorCard icon={<Bell size={15} strokeWidth={1.8} />} title={t ? `Edit “${t.name}”` : "New push notification"} problem={problem} busy={busy}
      saveLabel={t ? "Save changes" : "Add notification"} onCancel={onCancel} onSave={() => onSave({ ...s, name: s.name.trim() })}
      aside={<label className="ag-switch"><Switch checked={s.timestamp} onCheckedChange={(timestamp) => set({ timestamp })} label="Add the time" /><span>Add the time</span></label>}>
      <label>Name</label>
      <input autoFocus value={s.name} placeholder="e.g. Garage left open" onChange={(e) => set({ name: e.target.value })} />
      <label>Kind</label>
      <div className="ag-row">
        <Select<string> value={String(s.severity)} label="Severity" options={pick(data.severities, "No severity")} onValueChange={(v) => set({ severity: Number(v) })} />
        <Select<string> value={String(s.category)} label="Category" options={pick(data.categories, "No category")} onValueChange={(v) => set({ category: Number(v) })} />
      </div>
      <label>Title</label>
      <input value={s.subject} placeholder="What the notification says first" onChange={(e) => set({ subject: e.target.value })} />
      <label>Message</label>
      <textarea rows={3} value={s.message} onChange={(e) => set({ message: e.target.value })} />
      <label>Snapshots</label>
      <div className="ag-stack">
        {data.attachment_providers.length ? data.attachment_providers.map((p) => {
          const on = s.attachments.some((a) => a.owner === p.owner.id && a.id === p.id);
          return (
            <label key={`${p.owner.id}:${p.id}`} className="ag-check">
              <input type="checkbox" checked={on} onChange={() => set({ attachments: on ? s.attachments.filter((a) => !(a.owner === p.owner.id && a.id === p.id)) : [...s.attachments, { owner: p.owner.id, id: p.id }] })} />
              {refLabel(p.owner)} <span className="dim">{p.label}</span>
            </label>
          );
        }) : <span className="dim small">No cameras offer snapshots.</span>}
        {s.attachments.filter((a) => !data.attachment_providers.some((p) => p.owner.id === a.owner && p.id === a.id)).map((a) => (
          <span key={`${a.owner}:${a.id}`} className="small">{refLabel(named(a.owner))} <span className="dim">(no longer offered)</span></span>
        ))}
      </div>
    </EditorCard>
  );
}

export function EmailView({ agent, data, shell, reload }: { agent: Agent; data: EmailData; shell: Shell; reload: () => void }) {
  const dialog = useDialog();
  const w = useWrites(shell, reload);
  const [editing, setEditing] = useState<EmailTemplateView | "new" | null>(null);
  const remove = async (t: EmailTemplateView) => {
    if (await dialog.confirm({ title: `Remove “${t.name}”?`, description: "Programming that sends it will send nothing.", confirmLabel: "Remove", danger: true })) {
      await w.propose([{ op: "remove_email_template", agent: agent.id, id: t.id }], `Remove the email notification “${t.name}”.`);
    }
  };
  return (
    <div className="ag">
      <List kind="email notification" items={data.templates} w={w} onAdd={() => setEditing("new")} onEdit={setEditing} onRemove={remove}
        editor={editing && (
        <EmailEditor key={editing === "new" ? "new" : editing.id} t={editing === "new" ? null : editing} taken={data.templates.filter((x) => editing === "new" || x.id !== editing.id).map((x) => x.name.trim().toLowerCase())}
          busy={w.busy} onCancel={() => setEditing(null)}
          onSave={async (template) => {
            const ok = editing === "new"
              ? await w.propose([{ op: "add_email_template", agent: agent.id, template }], `Add the email notification “${template.name}”.`)
              : await w.propose([{ op: "modify_email_template", agent: agent.id, id: editing.id, template }], `Change the email notification “${editing.name}”.`);
            if (ok) setEditing(null);
          }} />
        )}>
        {(t) => <span className="ag-line dim small">to {t.to || "nobody yet"}{t.subject ? ` — ${t.subject}` : ""}</span>}
      </List>
      {!data.templates.length && !editing && <p className="empty pad">No email notifications set up.</p>}
    </div>
  );
}

function EmailEditor({ t, taken, busy, onCancel, onSave }: {
  t: EmailTemplateView | null; taken: string[]; busy: boolean; onCancel: () => void; onSave: (s: EmailTemplateSpec) => void;
}) {
  const [s, setS] = useState<EmailTemplateSpec>(() => (t ? { ...t.spec } : { name: "", to: "", subject: "", body: "", timestamp: true }));
  const set = (p: Partial<EmailTemplateSpec>) => setS((x) => ({ ...x, ...p }));
  const badAddress = s.to.split(/[,;]/).map((a) => a.trim()).find((a) => a && !a.includes("@"));
  const problem = !s.name.trim() ? "Give it a name." : taken.includes(s.name.trim().toLowerCase()) ? "Another email has that name."
    : badAddress ? `“${badAddress}” isn't an email address.` : null;
  return (
    <EditorCard icon={<Mail size={15} strokeWidth={1.8} />} title={t ? `Edit “${t.name}”` : "New email notification"} problem={problem} busy={busy}
      saveLabel={t ? "Save changes" : "Add email"} onCancel={onCancel} onSave={() => onSave({ ...s, name: s.name.trim() })}
      aside={<label className="ag-switch"><Switch checked={s.timestamp} onCheckedChange={(timestamp) => set({ timestamp })} label="Add the time" /><span>Add the time</span></label>}>
      <label>Name</label>
      <input autoFocus value={s.name} placeholder="e.g. Water leak" onChange={(e) => set({ name: e.target.value })} />
      <label>To</label>
      <input value={s.to} placeholder="name@example.com, another@example.com" onChange={(e) => set({ to: e.target.value })} />
      <label>Subject</label>
      <input value={s.subject} onChange={(e) => set({ subject: e.target.value })} />
      <label>Body</label>
      <textarea rows={4} value={s.body} onChange={(e) => set({ body: e.target.value })} />
    </EditorCard>
  );
}
