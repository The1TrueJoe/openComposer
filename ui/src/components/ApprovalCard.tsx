import { AlertTriangle, Check, ChevronDown, ChevronRight, CircleSlash, Clock, LifeBuoy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errText, type Approval, type ApprovalStatus } from "../api";
import { ago, cx, modKey, plural, typing } from "../lib/ui";
import { CopyButton, Spinner } from "./controls";
import { DiffView, SourceBadge } from "./DiffView";

const STATUS: Record<ApprovalStatus, string> = {
  pending: "Needs approval", applying: "Applying…", applied: "Applied", failed: "Failed", denied: "Declined", expired: "Expired",
};

/** One proposed change to a Director: the predicted diff, and what became of it.
 *
 *  Pending cards take the decision (with an optional note the AI sees if you decline);
 *  applied cards show whether Director did what was predicted, what else it did on its own,
 *  and where the restore point taken beforehand is. */
export function ApprovalCard({ approval: a, collapsible = false, autoFocus = false }: {
  approval: Approval;
  /** History cards start folded to their head; pending ones never fold. */
  collapsible?: boolean;
  autoFocus?: boolean;
}) {
  // Something decided a moment ago is what you're looking at: keep its outcome open.
  const fresh = !!a.decided && Date.now() - new Date(a.decided).getTime() < 120_000;
  const [open, setOpen] = useState(!collapsible || a.status === "pending" || a.status === "applying" || fresh);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus && a.status === "pending") ref.current?.focus({ preventScroll: true });
  }, [autoFocus, a.status]);

  const decide = async (approve: boolean) => {
    if (busy || a.status !== "pending") return;
    setBusy(true);
    try {
      const waiting = await api.decide(a.id, approve, note.trim() || undefined);
      if (!waiting) toast.warning("That proposal isn't waiting any more — it may have expired.");
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (a.status !== "pending" || !(e.metaKey || e.ctrlKey)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void decide(true);
    } else if (e.key === "Backspace" && !typing(e)) {
      e.preventDefault();
      void decide(false);
    }
  };

  const installs = a.ops.flatMap((o) => (o.op === "install_driver" ? [{ filename: o.filename, source: o.source }] : []));
  const title = a.descriptions.length > 1
    ? `${a.descriptions[0]} and ${plural(a.descriptions.length - 1, "more change")}`
    : a.descriptions[0] ?? "Change";

  return (
    <div ref={ref} className={cx("ac", a.status, open && "open")} tabIndex={-1} onKeyDown={onKey}
         aria-label={`${STATUS[a.status]}: ${title}`}>
      <button className="ac-head" onClick={() => collapsible && setOpen(!open)} disabled={!collapsible}>
        {collapsible && (open ? <ChevronDown size={13} strokeWidth={1.8} /> : <ChevronRight size={13} strokeWidth={1.8} />)}
        <span className={cx("ac-status", a.status)}>
          {a.status === "applying" && <Spinner />}
          {STATUS[a.status]}
        </span>
        <span className="ac-title">{title}</span>
        <span className="ac-when">{ago(a.decided ?? a.created)}</span>
      </button>

      {open && (
        <>
          <div className="ac-body">
            <DiffView diff={a.diff} header={{
              source: a.source, director: a.director_name, project: a.project, reason: a.reason, time: a.created,
              descriptions: a.descriptions, installs,
            }} empty={
              installs.length ? "No change to the project itself — devices use the file once it's there."
                : a.ops.some((o) => o.op === "run_action") ? "No change to the project — the action runs on the device itself."
                : undefined} />
          </div>
          <Footer a={a} note={note} setNote={setNote} busy={busy} decide={decide} />
        </>
      )}
      {!open && <div className="ac-fold"><SourceBadge source={a.source} /><span className="dim">{a.director_name}</span></div>}
    </div>
  );
}

function Footer({ a, note, setNote, busy, decide }: {
  a: Approval; note: string; setNote: (s: string) => void; busy: boolean; decide: (approve: boolean) => void;
}) {
  switch (a.status) {
    case "pending":
      return (
        <div className="ac-foot pending">
          {a.source !== "You (openComposer)" && (
            <textarea className="ac-note" rows={1} placeholder="Note for the AI (optional) — e.g. why you're declining"
                      value={note} onChange={(e) => setNote(e.target.value)} />
          )}
          <div className="ac-actions">
            <span className="kbd-hint">{modKey}↵ approve · {modKey}⌫ decline</span>
            <button className="act danger" disabled={busy} onClick={() => decide(false)}><X size={14} strokeWidth={1.8} />Decline</button>
            <button className="act primary" disabled={busy} onClick={() => decide(true)}><Check size={14} strokeWidth={1.8} />Approve &amp; apply</button>
          </div>
        </div>
      );
    case "applying":
      return (
        <div className="ac-foot">
          <p className="ac-line"><Spinner />Saving a restore point, applying to {a.director_name} and reading the project back…</p>
        </div>
      );
    case "applied":
    case "failed":
      return (
        <div className="ac-foot">
          {a.error && <p className="ac-error"><AlertTriangle size={14} strokeWidth={1.8} />{a.error}</p>}
          {a.verification && <VerificationView a={a} />}
          {a.note && <p className="ac-line dim">Your note: “{a.note}”</p>}
          {a.restore_point && (
            <div className="ac-restore">
              <LifeBuoy size={14} strokeWidth={1.8} />
              <span>Restore point</span>
              <code title={a.restore_point}>{a.restore_point.split(/[\\/]/).pop()}</code>
              <CopyButton text={a.restore_point} label="Copy path" />
            </div>
          )}
        </div>
      );
    case "denied":
      return (
        <div className="ac-foot">
          <p className="ac-line"><CircleSlash size={14} strokeWidth={1.8} />Declined — nothing was changed.</p>
          {a.note && <blockquote className="dv-reason">{a.note}</blockquote>}
        </div>
      );
    case "expired":
      return (
        <div className="ac-foot">
          <p className="ac-line"><Clock size={14} strokeWidth={1.8} />Nobody decided within 15 minutes; nothing was changed.</p>
        </div>
      );
  }
}

function VerificationView({ a }: { a: Approval }) {
  const v = a.verification!;
  const [showSide, setShowSide] = useState(false);
  const predicted = a.diff.changes.length;
  return (
    <div className="ac-verify">
      <p className={cx("ac-line", v.missing.length ? "warn" : "ok")}>
        {v.missing.length ? <AlertTriangle size={14} strokeWidth={1.8} /> : <Check size={14} strokeWidth={1.8} />}
        {v.matched} of {plural(predicted, "predicted change")} confirmed by reading the project back.
      </p>
      {!!v.missing.length && (
        <div className="ac-missing">
          <span className="label">Predicted but not seen</span>
          <ul>{v.missing.map((m) => <li key={m} className="mono">{m}</li>)}</ul>
        </div>
      )}
      {!!v.side_effects.changes.length && (
        <div className="ac-side">
          <button className="ac-side-head" onClick={() => setShowSide(!showSide)} aria-expanded={showSide}>
            {showSide ? <ChevronDown size={13} strokeWidth={1.8} /> : <ChevronRight size={13} strokeWidth={1.8} />}
            Director also changed {plural(v.side_effects.changes.length, "thing")}
            <span className="dim"> — its own follow-ups, not part of the proposal</span>
          </button>
          {showSide && <DiffView diff={v.side_effects} graph={false} />}
        </div>
      )}
    </div>
  );
}
