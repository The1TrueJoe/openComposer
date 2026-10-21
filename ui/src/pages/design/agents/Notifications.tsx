/** The Push Notification and Email Notification agents' own tabs, in place of Composer's
 *  editors: the messages programming can send, in a table with the picked one under it. Added,
 *  changed and removed as approvals (*_push_notification, *_email_template). */

import { createColumnHelper, type ColumnDef } from "@tanstack/react-table";
import { Bell, Camera, Mail, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { EmailData, EmailTemplateSpec, EmailTemplateView, NamedRef, PushData, PushTemplateSpec, PushTemplateView } from "../../../api";
import { DataTable } from "../../../components/DataTable";
import { Tip, useDialog } from "../../../components/Dialogs";
import { Select, Switch } from "../../../components/controls";
import type { Shell } from "../../../lib/shell";
import { cx, plural } from "../../../lib/ui";
import { AgentSplit, DetailPane, EditIcon, EditorCard, IconAct, Ref, RemoveIcon, refLabel, useWrites } from "./common";

type Agent = { id: number; name: string };

/** A template list both agents share: the table, the picked template (or the editor) under it. */
function Templates<T extends { id: number; name: string }>({ kind, id, items, w, columns, editing, setEditing, editor, onRemove, children }: {
  kind: string; id: string; items: T[]; w: ReturnType<typeof useWrites>;
  // Columns hold differently typed values.
  columns: ColumnDef<T, any>[];
  editing: T | "new" | null; setEditing: (t: T | "new" | null) => void;
  /** The open editor. */
  editor: React.ReactNode; onRemove: (t: T) => void;
  /** The picked template's details. */
  children: (t: T) => React.ReactNode;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const sel = items.find((t) => t.id === picked) ?? null;
  const Icon = kind.startsWith("push") ? Bell : Mail;
  return (
    <AgentSplit id={id} detail={editing ? editor : sel && (
      <DetailPane icon={<Icon size={14} strokeWidth={1.8} />} title={sel.name} tags={<span className="dim mono small">#{sel.id}</span>}
        actions={<>
          <IconAct label="Edit" why={w.why} disabled={w.busy} onClick={() => setEditing(sel)}><EditIcon /></IconAct>
          <IconAct label="Remove" why={w.why} disabled={w.busy} danger onClick={() => onRemove(sel)}><RemoveIcon /></IconAct>
        </>}>
        {children(sel)}
      </DetailPane>
    )} bar={<>
      <span className="dim small">{plural(items.length, kind)}</span>
      <span className="spread" />
      <Tip text={w.why ?? `Add a ${kind}`}>
        <span><button className="act small primary" disabled={!w.can} onClick={() => { setPicked(null); setEditing("new"); }}><Plus size={13} strokeWidth={2} />Add</button></span>
      </Tip>
    </>}>
      <DataTable data={items} columns={columns} rowId={(t) => String(t.id)} label={`${kind}s`} sort={[{ id: "name", desc: false }]}
        selected={sel ? String(sel.id) : null} onSelect={(t) => { setPicked(t.id); if (editing !== "new" && editing?.id !== t.id) setEditing(null); }}
        onActivate={(t) => { if (w.can) setEditing(t); }}
        empty={<p className="empty">No {kind}s set up.</p>} />
    </AgentSplit>
  );
}

const pushCol = createColumnHelper<PushTemplateView>();
const emailCol = createColumnHelper<EmailTemplateView>();

export function PushView({ agent, data, shell, onSelect, reload }: { agent: Agent; data: PushData; shell: Shell; onSelect: (id: number) => void; reload: () => void }) {
  const dialog = useDialog();
  const w = useWrites(shell, reload);
  const [editing, setEditing] = useState<PushTemplateView | "new" | null>(null);
  const remove = async (t: PushTemplateView) => {
    if (await dialog.confirm({ title: `Remove “${t.name}”?`, description: "Programming that sends it will send nothing.", confirmLabel: "Remove", danger: true })) {
      await w.propose([{ op: "remove_push_notification", agent: agent.id, id: t.id }], `Remove the push notification “${t.name}”.`);
    }
  };
  const columns = useMemo(() => [
    pushCol.accessor("name", { header: "Notification", cell: (c) => <span className="ellip">{c.getValue()}</span> }),
    pushCol.accessor((t) => t.severity ?? "", {
      id: "kind", header: "Kind", meta: { width: 168, hideBelow: 460 },
      cell: (c) => { const t = c.row.original; return <span className="row nowrap">{t.severity && <span className={cx("tag", t.severity === "Alarms" && "warn")}>{t.severity}</span>}{t.category && <span className="tag">{t.category}</span>}{!t.severity && !t.category && <span className="dim">—</span>}</span>; },
    }),
    pushCol.accessor("subject", { header: "Title", meta: { width: "36%", hideBelow: 380 }, cell: (c) => <span className="ellip dim">{c.getValue() || "—"}</span> }),
    pushCol.accessor((t) => t.attachments.length, { id: "snaps", header: "Snapshots", meta: { width: 80, align: "right", hideBelow: 540 }, cell: (c) => c.getValue() || <span className="dim">—</span> }),
  ], []);
  return (
    <Templates kind="push notification" id="push" items={data.templates} w={w} columns={columns} editing={editing} setEditing={setEditing} onRemove={remove}
      editor={editing && (
        <PushEditor key={editing === "new" ? "new" : editing.id} t={editing === "new" ? null : editing} data={data} busy={w.busy} onCancel={() => setEditing(null)}
          onSave={async (template) => {
            const ok = editing === "new"
              ? await w.propose([{ op: "add_push_notification", agent: agent.id, template }], `Add the push notification “${template.name}”.`)
              : await w.propose([{ op: "modify_push_notification", agent: agent.id, id: editing.id, template }], `Change the push notification “${editing.name}”.`);
            if (ok) setEditing(null);
          }} />
      )}>
      {(t) => (
        <dl className="ag-dl">
          <dt>Kind</dt><dd>{[t.severity, t.category].filter(Boolean).join(" · ") || <span className="dim">no severity or category</span>}</dd>
          <dt>Title</dt><dd>{t.subject || <span className="dim">none</span>}</dd>
          <dt>Message</dt><dd>{t.message || <span className="dim">none</span>}</dd>
          <dt>Time</dt><dd>{t.timestamp ? "Added to the message" : <span className="dim">not added</span>}</dd>
          <dt><Camera size={12} strokeWidth={1.8} />Snapshots</dt>
          <dd className="ag-refs">{t.attachments.length ? t.attachments.map((a, i) => <Ref key={i} r={a} onSelect={onSelect} />) : <span className="dim">none</span>}</dd>
        </dl>
      )}
    </Templates>
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
  const columns = useMemo(() => [
    emailCol.accessor("name", { header: "Email", cell: (c) => <span className="ellip">{c.getValue()}</span> }),
    emailCol.accessor("to", { header: "To", meta: { width: "32%", hideBelow: 380 }, cell: (c) => <span className="ellip dim">{c.getValue() || "nobody yet"}</span> }),
    emailCol.accessor("subject", { header: "Subject", meta: { width: "32%", hideBelow: 500 }, cell: (c) => <span className="ellip dim">{c.getValue() || "—"}</span> }),
  ], []);
  return (
    <Templates kind="email notification" id="email" items={data.templates} w={w} columns={columns} editing={editing} setEditing={setEditing} onRemove={remove}
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
      {(t) => (
        <dl className="ag-dl">
          <dt>To</dt><dd>{t.to || <span className="dim">nobody yet</span>}</dd>
          <dt>Subject</dt><dd>{t.subject || <span className="dim">none</span>}</dd>
          <dt>Body</dt><dd className="ag-pre">{t.message || <span className="dim">empty</span>}</dd>
          <dt>Time</dt><dd>{t.spec.timestamp ? "Added to the message" : <span className="dim">not added</span>}</dd>
        </dl>
      )}
    </Templates>
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
