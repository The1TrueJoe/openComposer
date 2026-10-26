/** The wizard the app opens on, like Composer Pro's "Connect to Director":
 *
 *  1. Controller — ones found on the network first (the primary, which runs the Director,
 *     ahead of secondaries), then saved ones that didn't answer, or add one by address.
 *  2. Certificate — only when the connection needs it (none imported yet, or the
 *     controller refused the one we have); drop the files or pick them, then it retries.
 *  3. Connecting — and the project opens. */

import { createColumnHelper } from "@tanstack/react-table";
import { ArrowLeft, Cable, KeyRound, ArrowRight, Check, Plug, Plus, Radar, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errText, type Announcement, type AppStatus, type DirectorInfo, type SavedDirector, type SidecarDetection, type SidecarSession } from "../api";
import { cx } from "../lib/ui";
import { Spinner } from "./controls";
import { DataTable } from "./DataTable";
import { Tip } from "./Dialogs";
import { AddDirectorForm, CertificateForm } from "./setup";
import { ReadOnlyLock } from "./shell";

/** Errors that mean "this controller wants a (different) client certificate". */
const NEEDS_CERT = /certificate|access denied|handshake|tls/i;

type Target = { id: string; name: string };
/** How to reach the controller, chosen in step 1; step 2 shows what that method finds. */
type Method = "network" | "sidecar" | "address";
type Step =
  | { kind: "method" }
  | { kind: "controller"; method: Method }
  | { kind: "certificate"; target: Target; why: string | null }
  | { kind: "connecting"; target: Target };

const STEPS = ["Connection", "Controller", "Certificate", "Open project"] as const;

export function ConnectScreen({ status, info, onChanged, onEnter }: {
  status: AppStatus; info: Map<string, DirectorInfo>; onChanged: () => void; onEnter: () => void;
}) {
  const { directors, active_director } = status.config;
  const [step, setStep] = useState<Step>({ kind: "method" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [found, setFound] = useState<Announcement[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [sidecar, setSidecar] = useState<SidecarDetection | null>(null);
  // Remembered so the certificate step (reached mid-connect) returns to the same method.
  const [lastMethod, setLastMethod] = useState<Method>("network");

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

  // Is Composer running a remote-support session on this computer? If so, offer to connect
  // through it. Read-only: this only looks at local interfaces and probes the Director port.
  useEffect(() => {
    let alive = true;
    api.detectSidecar().then((d) => { if (alive) setSidecar(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

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
        setStep({ kind: "controller", method: lastMethod });
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

  /** A detected Composer remote session: save it as a Director (if it isn't yet), then connect. */
  const connectSidecar = async (s: SidecarSession) => {
    const existing = directors.find((d) => d.host.toLowerCase() === s.director_addr.toLowerCase());
    if (existing) return connect({ id: existing.id, name: existing.name });
    const key = `sidecar:${s.director_addr}`;
    setBusy(key);
    try {
      const d = await api.addDirector(`Composer session (${s.adapter_ip})`, s.director_addr, "approve");
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

  const at = step.kind === "method" ? 0 : step.kind === "controller" ? 1 : step.kind === "certificate" ? 2 : 3;
  const sidecarReady = !!sidecar && sidecar.sessions.length > 0;
  /** Jump to step 2 for a chosen method. */
  const choose = (method: Method) => { setLastMethod(method); setStep({ kind: "controller", method }); };

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

        {step.kind === "method" && <>
          <h1>Connect to a Director</h1>
          {!status.identity.unlocked && (
            <p className="hint"><KeyRound size={13} strokeWidth={1.8} /> Unlocking your certificate — if macOS asks to use the keychain, choose Allow (or Always Allow).</p>
          )}
          <p className="lede">How do you want to reach the controller?</p>

          <div className="method-grid">
            <button className="method-tile" onClick={() => choose("network")}>
              <Radar size={18} strokeWidth={1.8} />
              <b>On your network</b>
              <span className="dim small">
                Find controllers on this network.
                {found !== null && (found.length ? ` ${found.length} found.` : " None answered yet.")}
              </span>
            </button>

            <button className="method-tile" disabled={!sidecarReady} onClick={() => choose("sidecar")}>
              <Cable size={18} strokeWidth={1.8} />
              <b>Composer remote session</b>
              <span className="dim small">
                {sidecarReady
                  ? `A Composer remote session is open here — ${sidecar!.sessions.length} controller${sidecar!.sessions.length > 1 ? "s" : ""} reachable through it.`
                  : "Attach through an open Composer Pro remote-support session (none detected on this computer)."}
              </span>
            </button>

            <button className="method-tile" onClick={() => choose("address")}>
              <Plus size={18} strokeWidth={1.8} />
              <b>Enter an address</b>
              <span className="dim small">Type a host or IP — or a forwarded <span className="mono">127.0.0.1:port</span>.</span>
            </button>
          </div>

          <div className="connect-foot">
            <button className="link" onClick={onEnter}>Continue without connecting</button>
            <span className="hint">Backups, settings and the agent work offline.</span>
          </div>
        </>}

        {step.kind === "controller" && step.method === "network" && <>
          <h1>Controllers on your network</h1>
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
                ? <p className="empty">No controllers answered. If you're on the right network, macOS may be asking to allow local network access — or go back and enter an address.</p>
                : <ControllerTable rows={foundRows} busy={busy} label="Controllers on your network" />}
          </section>

          {!!others.length && (
            <section className="connect-sec">
              <div className="connect-head">Saved</div>
              <ControllerTable rows={savedRows} busy={busy} label="Saved Directors" />
            </section>
          )}

          <BackFoot onBack={() => setStep({ kind: "method" })} />
        </>}

        {step.kind === "controller" && step.method === "sidecar" && <>
          <h1><span className="row nowrap"><Cable size={18} strokeWidth={1.8} />Composer remote session</span></h1>
          <p className="lede">
            openComposer attaches to Composer Pro's remote-support session as an additional standard client —
            it doesn't replace Composer and doesn't change how the controller authenticates.
          </p>

          {sidecarReady
            ? <div className="connect-list">
                {sidecar!.sessions.map((s) => {
                  const key = `sidecar:${s.director_addr}`;
                  return (
                    <div key={s.director_addr} className="connect-row">
                      <span className="connect-text">
                        <b>Composer remote session detected</b>
                        <span className="dim small">
                          connect to <span className="mono">{s.director_addr}</span> (adapter {s.interface})
                          {!s.reachable && " — no Director has answered yet"}
                        </span>
                        {errors[key] && <span className="err small">{errors[key]}</span>}
                      </span>
                      <button className="act small primary spread" disabled={!!busy} onClick={() => connectSidecar(s)}>
                        {busy === key ? <Spinner /> : <Plug size={13} strokeWidth={1.8} />}Connect
                      </button>
                    </div>
                  );
                })}
              </div>
            : <p className="empty">No Composer remote session is open on this computer. Start one in Composer Pro, or forward the PC's <span className="mono">10.123.x.y:5021</span> here and go back to enter an address.</p>}

          <BackFoot onBack={() => setStep({ kind: "method" })} />
        </>}

        {step.kind === "controller" && step.method === "address" && <>
          <h1>Enter an address</h1>
          <p className="lede">A host name or IP, or a forwarded local address like <span className="mono">127.0.0.1:15021</span>.</p>
          <AddDirectorForm onAdded={(id) => {
            onChanged();
            void connect({ id, name: "the new Director" });
          }} />
          <BackFoot onBack={() => setStep({ kind: "method" })} />
        </>}

        {step.kind === "certificate" && <>
          <h1>Certificate for {step.target.name}</h1>
          <p className="lede">
            {step.why
              ? <>The controller refused the connection ({step.why}). Use a client certificate it trusts.</>
              : <>Controllers only talk to a client holding a certificate they trust: a <code>.pem</code> with its <code>.key</code>, or a <code>.p12</code>. openComposer doesn't include one.</>}
          </p>
          <CertificateForm identity={status.identity} onChanged={() => { onChanged(); void connect(step.target, true); }} />
          <BackFoot onBack={() => setStep({ kind: "controller", method: lastMethod })} />
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

/** The step-2 footer: a Back to the connection-method choice. */
function BackFoot({ onBack }: { onBack: () => void }) {
  return (
    <div className="connect-foot">
      <button className="act quiet" onClick={onBack}><ArrowLeft size={14} strokeWidth={1.8} />Back</button>
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
