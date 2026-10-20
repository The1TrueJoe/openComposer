/** The wizard the app opens on, like Composer Pro's "Connect to Director":
 *
 *  1. Controller — ones found on the network first (the primary, which runs the Director,
 *     ahead of secondaries), then saved ones that didn't answer, or add one by address.
 *  2. Certificate — only when the connection needs it (none imported yet, or the
 *     controller refused the one we have); drop the files or pick them, then it retries.
 *  3. Connecting — and the project opens. */

import { createColumnHelper } from "@tanstack/react-table";
import { ArrowLeft, KeyRound, ArrowRight, Check, Plug, Plus, Radar, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errText, type Announcement, type AppStatus, type DirectorInfo, type SavedDirector } from "../api";
import { cx } from "../lib/ui";
import { Spinner } from "./controls";
import { DataTable } from "./DataTable";
import { Tip } from "./Dialogs";
import { AddDirectorForm, CertificateForm } from "./setup";
import { ReadOnlyLock } from "./shell";

/** Errors that mean "this controller wants a (different) client certificate". */
const NEEDS_CERT = /certificate|access denied|handshake|tls/i;

type Target = { id: string; name: string };
type Step =
  | { kind: "controller" }
  | { kind: "certificate"; target: Target; why: string | null }
  | { kind: "connecting"; target: Target };

const STEPS = ["Controller", "Certificate", "Open project"] as const;

export function ConnectScreen({ status, info, onChanged, onEnter }: {
  status: AppStatus; info: Map<string, DirectorInfo>; onChanged: () => void; onEnter: () => void;
}) {
  const { directors, active_director } = status.config;
  const [step, setStep] = useState<Step>({ kind: "controller" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [found, setFound] = useState<Announcement[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setFound(await api.discoverControllers());
    } catch {
      setFound([]);
    } finally {
      setScanning(false);
    }
  }, []);
  useEffect(() => { void scan(); }, [scan]);

  /** `haveCert` skips the up-front check right after an import, before status refreshes. */
  const connect = async (t: Target, haveCert = status.identity.loaded) => {
    if (!haveCert) {
      setStep({ kind: "certificate", target: t, why: null });
      return;
    }
    setStep({ kind: "connecting", target: t });
    setErrors((e) => ({ ...e, [t.id]: "" }));
    try {
      // Only a Director that answered becomes the active one.
      await api.connect(t.id);
      await api.setActiveDirector(t.id);
      onChanged();
      onEnter();
    } catch (e) {
      const msg = errText(e);
      if (NEEDS_CERT.test(msg)) {
        setStep({ kind: "certificate", target: t, why: msg });
      } else {
        setErrors((x) => ({ ...x, [t.id]: msg }));
        setStep({ kind: "controller" });
      }
    }
  };

  const savedFor = (f: Announcement): SavedDirector | undefined =>
    directors.find((d) => [f.address, f.host].some((x) => x && x.toLowerCase() === d.host.toLowerCase()));

  /** A controller from the scan: save it (if it isn't yet), then connect. */
  const connectFound = async (f: Announcement) => {
    const existing = savedFor(f);
    if (existing) return connect({ id: existing.id, name: existing.name });
    const key = `found:${f.address}`;
    setBusy(key);
    try {
      const d = await api.addDirector(f.host || `${f.model || "Controller"} (${f.address})`, f.address, "approve");
      onChanged();
      await connect({ id: d.id, name: d.name });
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: errText(e) }));
    } finally {
      setBusy(null);
    }
  };

  const seen = new Set((found ?? []).map((f) => savedFor(f)?.id).filter(Boolean));
  // Saved Directors that didn't answer the scan: last used first, then by name — fixed when
  // the wizard opens, so rows don't move under the pointer.
  const [first] = useState(active_director);
  const others = directors
    .filter((d) => !seen.has(d.id))
    .sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : a.name.localeCompare(b.name)));

  const at = step.kind === "controller" ? 0 : step.kind === "certificate" ? 1 : 2;

  // The Director first, then secondaries (dimmed, nothing to open).
  const foundRows: ControllerRow[] = (found ?? [])
    .map((f): ControllerRow => {
      const sd = savedFor(f);
      const key = sd?.id ?? `found:${f.address}`;
      return {
        key, name: sd?.name ?? (f.host || f.model), address: f.address, model: f.model || f.device_type,
        os: sd ? info.get(sd.id)?.version ?? null : null, readOnly: sd?.mode === "read_only", secondary: f.director === "disabled",
        open: !!sd && status.connected.includes(sd.id), error: errors[key] || null, last: false, go: () => connectFound(f),
      };
    })
    .sort((a, b) => Number(a.secondary) - Number(b.secondary));
  const savedRows: ControllerRow[] = others.map((d) => ({
    key: d.id, name: d.name, address: d.host, model: null, os: info.get(d.id)?.version ?? null, readOnly: d.mode === "read_only",
    secondary: false, open: status.connected.includes(d.id), error: errors[d.id] || null, last: d.id === first, go: () => connect(d),
  }));

  return (
    <div className="connect">
      <div className="connect-card">
        <ol className="wizard-steps">
          {STEPS.map((label, i) => (
            <li key={label} className={cx(i === at && "on", i < at && "done")}>
              <span className="wizard-n">{i < at ? <Check size={12} strokeWidth={2.2} /> : i + 1}</span>{label}
            </li>
          ))}
        </ol>

        {step.kind === "controller" && <>
          <h1>Connect to a Director</h1>
          {!status.identity.unlocked && (
            <p className="hint"><KeyRound size={13} strokeWidth={1.8} /> Unlocking your certificate — if macOS asks to use the keychain, choose Allow (or Always Allow).</p>
          )}
          <p className="lede">Pick the controller whose project you want to open.</p>

          <section className="connect-sec">
            <div className="connect-head">
              On your network
              <button className="act small quiet" onClick={scan} disabled={scanning}>
                {scanning ? <Spinner /> : <RefreshCw size={12} strokeWidth={1.8} />}Scan again
              </button>
            </div>
            {found === null || (scanning && !found.length)
              ? <p className="hint"><Radar size={13} strokeWidth={1.8} /> Looking for controllers…</p>
              : !found.length
                ? <p className="empty">No controllers answered. If you're on the right network, macOS may be asking to allow local network access — or add one by address below.</p>
                : <ControllerTable rows={foundRows} busy={busy} label="Controllers on your network" />}
          </section>

          {!!others.length && (
            <section className="connect-sec">
              <div className="connect-head">Saved</div>
              <ControllerTable rows={savedRows} busy={busy} label="Saved Directors" />
            </section>
          )}

          <section className="connect-sec">
            {adding
              ? <>
                  <div className="connect-head">Add by address</div>
                  <AddDirectorForm onAdded={(id) => {
                    onChanged();
                    void connect({ id, name: "the new Director" });
                  }} />
                </>
              : <button className="act quiet" onClick={() => setAdding(true)}><Plus size={14} strokeWidth={1.8} />Add a Director by address…</button>}
          </section>

          <div className="connect-foot">
            <button className="link" onClick={onEnter}>Continue without connecting</button>
            <span className="hint">Backups, settings and the agent work offline.</span>
          </div>
        </>}

        {step.kind === "certificate" && <>
          <h1>Certificate for {step.target.name}</h1>
          <p className="lede">
            {step.why
              ? <>The controller refused the connection ({step.why}). Use the client certificate it trusts — the one Composer Pro uses.</>
              : <>Controllers only talk to a client holding a trusted certificate — the one Composer Pro uses: <code>composer.pem</code> with its <code>composer.key</code>, or a <code>.p12</code>.</>}
          </p>
          <CertificateForm identity={status.identity} onChanged={() => { onChanged(); void connect(step.target, true); }} />
          <div className="connect-foot">
            <button className="act quiet" onClick={() => setStep({ kind: "controller" })}><ArrowLeft size={14} strokeWidth={1.8} />Back</button>
          </div>
        </>}

        {step.kind === "connecting" && (
          <div className="connecting">
            <Spinner />
            <h1>Connecting to {step.target.name}…</h1>
            <p className="lede">Reading the project from the Director.</p>
          </div>
        )}
      </div>
    </div>
  );
}

interface ControllerRow {
  key: string;
  name: string;
  address: string;
  model: string | null;
  os: string | null;
  readOnly: boolean;
  /** A controller without a Director of its own: listed so nothing looks missing. */
  secondary: boolean;
  /** Already connected: the action opens it. */
  open: boolean;
  error: string | null;
  /** The one used last time. */
  last: boolean;
  go: () => void;
}

const col = createColumnHelper<ControllerRow>();

function ControllerTable({ rows, busy, label }: { rows: ControllerRow[]; busy: string | null; label: string }) {
  const [sel, setSel] = useState<string | null>(rows.find((r) => r.last)?.key ?? rows.find((r) => !r.secondary)?.key ?? null);
  const columns = useMemo(() => [
    col.accessor("name", {
      header: "Name", meta: { width: "31%" },
      cell: (c) => (
        <span className="ct-name">
          <span className="row nowrap">
            <b>{c.getValue()}</b>
            {c.row.original.readOnly && <ReadOnlyLock name={c.getValue()} />}
            {c.row.original.last && <span className="dim small">last used</span>}
          </span>
          {c.row.original.secondary && <span className="dim small">Secondary controller — the project lives on the Director.</span>}
          {c.row.original.error && <span className="err small">{c.row.original.error}</span>}
        </span>
      ),
    }),
    col.accessor("address", { header: "Address", meta: { width: "22%", className: "mono nowrap-cell" }, cell: (c) => <span className="ellip" title={c.getValue()}>{c.getValue()}</span> }),
    col.accessor("model", { header: "Model", meta: { className: "nowrap-cell" }, cell: (c) => c.getValue() ?? <span className="dim">—</span> }),
    col.accessor("os", { header: "OS", meta: { width: 104, className: "mono nowrap-cell" }, cell: (c) => c.getValue() ?? <span className="dim">—</span> }),
    col.display({
      id: "go", meta: { width: 112, align: "right" },
      cell: (c) => {
        const r = c.row.original;
        if (r.secondary) return <Tip text="Only the main controller runs a Director"><span className="tag">secondary</span></Tip>;
        return (
          <button className="act small primary" disabled={!!busy} onClick={r.go}>
            {busy === r.key ? <Spinner /> : r.open ? <ArrowRight size={13} strokeWidth={1.8} /> : <Plug size={13} strokeWidth={1.8} />}
            {r.open ? "Open" : "Connect"}
          </button>
        );
      },
    }),
  ], [busy]);
  return (
    <DataTable data={rows} columns={columns} rowId={(r) => r.key} label={label} scroll={false} className="connect-table"
               selected={sel} onSelect={(r) => setSel(r.key)} onActivate={(r) => { if (!r.secondary && !busy) r.go(); }}
               rowClass={(r) => cx(r.secondary && "dimmed", r.last && "last")} />
  );
}
