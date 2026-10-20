/** The screen the app opens on, like Composer Pro's "Connect to Director".
 *
 *  Controllers found on the network come first; saved ones that didn't answer (a Virtual
 *  Director, another site) follow. Connecting is the first step — the client certificate
 *  is only asked for when a connection needs it, and the connection is retried once it's
 *  imported. The project opens as soon as a Director connects. */

import { ArrowRight, KeyRound, Lock, Plug, Plus, Radar, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errText, type Announcement, type AppStatus, type DirectorInfo, type SavedDirector } from "../api";
import { cx } from "../lib/ui";
import { Spinner } from "./controls";
import { AddDirectorForm, CertificateForm } from "./setup";

/** Errors that mean "this controller wants a (different) client certificate". */
const NEEDS_CERT = /certificate|access denied|handshake|tls/i;

type Target = { id: string; name: string };

export function ConnectScreen({ status, info, onChanged, onEnter }: {
  status: AppStatus; info: Map<string, DirectorInfo>; onChanged: () => void; onEnter: () => void;
}) {
  const { directors, active_director } = status.config;
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [found, setFound] = useState<Announcement[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [certFor, setCertFor] = useState<(Target & { why: string | null }) | null>(null);

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
      setCertFor({ ...t, why: null });
      return;
    }
    setBusy(t.id);
    setErrors((e) => ({ ...e, [t.id]: "" }));
    try {
      // Only a Director that answered becomes the active one.
      await api.connect(t.id);
      await api.setActiveDirector(t.id);
      setCertFor(null);
      onChanged();
      onEnter();
    } catch (e) {
      const msg = errText(e);
      if (NEEDS_CERT.test(msg)) setCertFor({ ...t, why: msg });
      else setErrors((x) => ({ ...x, [t.id]: msg }));
    } finally {
      setBusy(null);
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
      setBusy(null);
      await connect({ id: d.id, name: d.name });
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: errText(e) }));
      setBusy(null);
    }
  };

  const seen = new Set((found ?? []).map((f) => savedFor(f)?.id).filter(Boolean));
  // Saved Directors that didn't answer the scan: last used first, then by name — fixed when
  // the screen opens, so rows don't move under the pointer.
  const [first] = useState(active_director);
  const others = directors
    .filter((d) => !seen.has(d.id))
    .sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : a.name.localeCompare(b.name)));

  return (
    <div className="connect">
      <div className="connect-card">
        <h1>Connect to a Director</h1>
        <p className="lede">Pick the controller whose project you want to open.</p>

        {certFor && (
          <section className="connect-sec connect-cert">
            <div className="connect-head"><span><KeyRound size={12} strokeWidth={1.8} /> Certificate for {certFor.name}</span></div>
            <p className="hint">
              {certFor.why
                ? <>The controller refused the connection ({certFor.why}). Import the client certificate it trusts — the one Composer Pro uses.</>
                : <>Controllers only talk to a trusted client certificate: import the one Composer Pro uses (<code>composer.pem</code> + <code>composer.key</code>, or a <code>.p12</code>). It's kept encrypted on this computer.</>}
            </p>
            <CertificateForm identity={status.identity} onChanged={() => { onChanged(); void connect(certFor, true); }} />
            <button className="link" onClick={() => setCertFor(null)}>Cancel</button>
          </section>
        )}

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
              : (
                <div className="connect-list">
                  {found.map((f) => {
                    if (f.director === "disabled") {
                      return (
                        <div key={f.host || f.address} className="connect-row secondary">
                          <span className="dot" />
                          <div className="connect-text">
                            <b>{f.host || f.model}</b>
                            <span className="dim mono">{f.address} · {f.model || f.device_type}</span>
                            <span className="dim">Secondary controller — no Director here; the project lives on the main controller.</span>
                          </div>
                          <span className="tag">secondary</span>
                        </div>
                      );
                    }
                    const s = savedFor(f);
                    const key = s?.id ?? `found:${f.address}`;
                    const on = !!s && status.connected.includes(s.id);
                    const v = s ? info.get(s.id)?.version : undefined;
                    return (
                      <div key={f.host || f.address} className="connect-row" onDoubleClick={() => !busy && connectFound(f)}>
                        <span className={cx("dot", on && "on")} />
                        <div className="connect-text">
                          <b>{s?.name ?? f.host ?? f.model}</b>
                          <span className="dim mono">{f.address} · {f.model || f.device_type}{v ? ` · OS ${v}` : ""}</span>
                          {errors[key] && <span className="err">{errors[key]}</span>}
                        </div>
                        {s && <ModeTag mode={s.mode} />}
                        <button className="act primary" disabled={!!busy} onClick={() => connectFound(f)}>
                          {busy === key ? <Spinner /> : on ? <ArrowRight size={14} strokeWidth={1.8} /> : <Plug size={14} strokeWidth={1.8} />}
                          {on ? "Open" : "Connect"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
        </section>

        {!!others.length && (
          <section className="connect-sec">
            <div className="connect-head">Saved</div>
            <div className="connect-list">
              {others.map((d) => {
                const on = status.connected.includes(d.id);
                const v = info.get(d.id)?.version;
                return (
                  <div key={d.id} className={cx("connect-row", d.id === first && "last")} onDoubleClick={() => !busy && connect(d)}>
                    <span className={cx("dot", on && "on")} />
                    <div className="connect-text">
                      <b>{d.name}</b>
                      <span className="dim mono">{d.host}{v ? ` · OS ${v}` : ""}</span>
                      {errors[d.id] && <span className="err">{errors[d.id]}</span>}
                    </div>
                    <ModeTag mode={d.mode} />
                    <button className="act primary" disabled={!!busy} onClick={() => connect(d)}>
                      {busy === d.id ? <Spinner /> : on ? <ArrowRight size={14} strokeWidth={1.8} /> : <Plug size={14} strokeWidth={1.8} />}
                      {on ? "Open" : "Connect"}
                    </button>
                  </div>
                );
              })}
            </div>
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
      </div>
    </div>
  );
}

function ModeTag({ mode }: { mode: SavedDirector["mode"] }) {
  return mode === "read_only"
    ? <span className="tag"><Lock size={11} strokeWidth={1.8} /> read only</span>
    : <span className="tag accent">approve</span>;
}
