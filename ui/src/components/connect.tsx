/** The screen the app opens on, like Composer Pro's "Connect to Director": pick a saved
 *  Director, one found on the network, or add one by address. The project only opens
 *  once a Director is connected (or you choose to continue without one). */

import { Lock, Plug, Plus, Radar, RefreshCw, ArrowRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errText, type Announcement, type AppStatus, type DirectorInfo } from "../api";
import { cx } from "../lib/ui";
import { Spinner } from "./controls";
import { AddDirectorForm, CertificateForm } from "./setup";

export function ConnectScreen({ status, info, onChanged, onEnter }: {
  status: AppStatus; info: Map<string, DirectorInfo>; onChanged: () => void; onEnter: () => void;
}) {
  const { directors, active_director } = status.config;
  const certified = status.identity.loaded;
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [found, setFound] = useState<Announcement[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);

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

  const connect = async (id: string) => {
    setBusy(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      // Only a Director that answered becomes the active one.
      await api.connect(id);
      await api.setActiveDirector(id);
      onChanged();
      onEnter();
    } catch (e) {
      setErrors((x) => ({ ...x, [id]: errText(e) }));
    } finally {
      setBusy(null);
    }
  };

  const addAndConnect = async (f: Announcement) => {
    const key = `found:${f.address}`;
    setBusy(key);
    try {
      const d = await api.addDirector(`${f.model || "Controller"} (${f.address})`, f.address, "approve");
      onChanged();
      setBusy(null);
      await connect(d.id);
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: errText(e) }));
      setBusy(null);
    }
  };

  const saved = new Set(directors.flatMap((d) => [d.host.toLowerCase(), d.name.toLowerCase()]));
  const newOnNetwork = (found ?? []).filter((f) => !saved.has(f.address.toLowerCase()) && !saved.has(f.host.toLowerCase()));
  // The last one used first, then by name — fixed when the screen opens, so rows don't move
  // under the pointer while you're choosing.
  const [first] = useState(active_director);
  const ordered = [...directors].sort((a, b) =>
    a.id === first ? -1 : b.id === first ? 1 : a.name.localeCompare(b.name));

  return (
    <div className="connect">
      <div className="connect-card">
        <h1>Connect to a Director</h1>
        <p className="lede">Pick the controller whose project you want to open.</p>

        {!certified && (
          <section className="connect-sec">
            <div className="connect-head">Client certificate first</div>
            <p className="hint">Composer Pro's <code>composer.pem</code> (often with a separate <code>.key</code>), or a <code>.p12</code>. Kept encrypted on this computer, with the key in the OS keychain.</p>
            <CertificateForm identity={status.identity} onChanged={onChanged} />
          </section>
        )}

        <section className="connect-sec">
          <div className="connect-head">Your Directors</div>
          {!ordered.length && <p className="empty">None saved yet — pick one found on the network below, or add one by address.</p>}
          <div className="connect-list">
            {ordered.map((d) => {
              const on = status.connected.includes(d.id);
              const v = info.get(d.id)?.version;
              return (
                <div key={d.id} className={cx("connect-row", d.id === first && "last")}
                     onDoubleClick={() => certified && !busy && connect(d.id)}>
                  <span className={cx("dot", on && "on")} />
                  <div className="connect-text">
                    <b>{d.name}</b>
                    <span className="dim mono">{d.host}{v ? ` · OS ${v}` : ""}</span>
                    {errors[d.id] && <span className="err">{errors[d.id]}</span>}
                  </div>
                  {d.mode === "read_only"
                    ? <span className="tag"><Lock size={11} strokeWidth={1.8} /> read only</span>
                    : <span className="tag accent">approve</span>}
                  <button className="act primary" disabled={!certified || !!busy} onClick={() => connect(d.id)}>
                    {busy === d.id ? <Spinner /> : on ? <ArrowRight size={14} strokeWidth={1.8} /> : <Plug size={14} strokeWidth={1.8} />}
                    {on ? "Open" : "Connect"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="connect-sec">
          <div className="connect-head">
            On this network
            <button className="act small quiet" onClick={scan} disabled={scanning}>
              {scanning ? <Spinner /> : <RefreshCw size={12} strokeWidth={1.8} />}Scan again
            </button>
          </div>
          {found === null || (scanning && !newOnNetwork.length)
            ? <p className="hint"><Radar size={13} strokeWidth={1.8} /> Looking for controllers (SDDP)…</p>
            : !newOnNetwork.length
              ? <p className="empty">{found.length ? "Every controller that answered is already saved above." : "No controllers answered on this network."}</p>
              : (
                <div className="connect-list">
                  {newOnNetwork.map((f) => {
                    const key = `found:${f.address}`;
                    return (
                      <div key={f.host || f.address} className="connect-row">
                        <span className="dot" />
                        <div className="connect-text">
                          <b>{f.model || f.device_type}</b>
                          <span className="dim mono">{f.address} · {f.host}</span>
                          {errors[key] && <span className="err">{errors[key]}</span>}
                        </div>
                        <button className="act" disabled={!certified || !!busy} onClick={() => addAndConnect(f)}>
                          {busy === key ? <Spinner /> : <Plus size={14} strokeWidth={1.8} />}Add & connect
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
        </section>

        <section className="connect-sec">
          {adding
            ? <>
                <div className="connect-head">Add by address</div>
                <AddDirectorForm onAdded={(id) => { onChanged(); void connect(id); }} />
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
