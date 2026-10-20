/** The two things openComposer needs before it can talk to anything — a client certificate and
 *  a Director — shared by first-run onboarding and Settings. */

import { FileKey2, KeyRound, Radar, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errText, type AccessMode, type Announcement, type IdentityStatus } from "../api";
import { baseName, pickFiles } from "../lib/files";
import { Select, Spinner } from "./controls";

export const MODES: { value: AccessMode; label: string }[] = [
  { value: "approve", label: "Approve each write" },
  { value: "read_only", label: "Read only" },
];

export function CertificateForm({ identity, onChanged }: { identity: IdentityStatus; onChanged: () => void }) {
  const [p12, setP12] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
      toast.success("Certificate imported");
      setP12(null);
      setPassword("");
      onChanged();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const importPem = async () => {
    const files = await pickFiles({ title: "Choose composer.pem (and its .key, if separate)", extensions: ["pem", "key", "crt", "cer"], multiple: true });
    if (!files.length) return;
    // Composer's own export is one file with both; some tools write the key separately.
    const key = files.length > 1 ? files.find((f) => /key/i.test(baseName(f))) ?? files[1] : null;
    const cert = files.find((f) => f !== key) ?? files[0];
    await run(() => api.importPem(cert, key));
  };

  return (
    <div className="cert">
      <div className="cert-state">
        {identity.loaded
          ? <><ShieldCheck size={16} strokeWidth={1.8} className="ok" /><div><b>{identity.label}</b>
              {identity.fingerprint && <div className="mono dim">{identity.fingerprint}</div>}</div></>
          : <><KeyRound size={16} strokeWidth={1.8} className="dim" /><div><b>No certificate</b>
              <div className="dim">Directors only talk to a client holding a Composer certificate.</div></div></>}
      </div>
      {identity.error && <p className="err">{identity.error}</p>}
      <div className="row">
        <button className="act" disabled={busy} onClick={importPem}><FileKey2 size={14} strokeWidth={1.8} />Import PEM…</button>
        <button className="act" disabled={busy} onClick={async () => {
          const [f] = await pickFiles({ title: "Choose a .p12 certificate", extensions: ["p12", "pfx"] });
          if (f) setP12(f);
        }}><FileKey2 size={14} strokeWidth={1.8} />Import .p12…</button>
        {busy && <Spinner />}
      </div>
      {p12 && (
        <form className="row p12" onSubmit={(e) => { e.preventDefault(); void run(() => api.importP12(p12, password)); }}>
          <code>{baseName(p12)}</code>
          <input type="password" placeholder="Password" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} />
          <button className="act primary" disabled={busy}>Import</button>
          <button type="button" className="act quiet" onClick={() => setP12(null)}>Cancel</button>
        </form>
      )}
    </div>
  );
}

/** Add a Director by address, or pick one SDDP found on this network. */
export function AddDirectorForm({ onAdded }: { onAdded: (id: string) => void }) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [mode, setMode] = useState<AccessMode>("approve");
  const [found, setFound] = useState<Announcement[] | null>(null);
  const [scanning, setScanning] = useState(false);

  const discover = async () => {
    setScanning(true);
    try {
      setFound(await api.discoverControllers());
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setScanning(false);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const d = await api.addDirector(name.trim(), host.trim(), mode);
      toast.success(`Added ${d.name}`);
      setName("");
      setHost("");
      setFound(null);
      onAdded(d.id);
    } catch (err) {
      toast.error(errText(err));
    }
  };

  return (
    <div className="add-director">
      <form className="row" onSubmit={add}>
        <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Host or IP address" value={host} onChange={(e) => setHost(e.target.value)} />
        <Select value={mode} onValueChange={setMode} options={MODES} label="Access" />
        <button className="act primary" disabled={!host.trim()}><Plus size={14} strokeWidth={1.8} />Add</button>
        <button type="button" className="act" onClick={discover} disabled={scanning}>
          {scanning ? <Spinner /> : <Radar size={14} strokeWidth={1.8} />}Discover controllers
        </button>
      </form>
      {found && (
        <div className="found-list">
          {!found.length && <p className="empty">No controllers answered on this network.</p>}
          {found.map((f) => (
            <button key={f.host} className="found-row" onClick={() => { setHost(f.address); setName(name || `${f.model || "Controller"} (${f.address})`); }}>
              <b>{f.model || f.device_type}</b>
              <span className="mono">{f.address}</span>
              <span className="dim mono">{f.host}</span>
              <span className="spread dim">use</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
