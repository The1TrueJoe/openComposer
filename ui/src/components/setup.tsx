/** The two things openComposer needs before it can talk to anything — a client certificate and
 *  a Director — shared by the connect wizard and Settings. */

import { FileKey2, KeyRound, Radar, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errText, type AccessMode, type Announcement, type IdentityStatus } from "../api";
import { useDropFiles } from "../lib/drop";
import { baseName, pickFiles } from "../lib/files";
import { cx } from "../lib/ui";
import { Select, Spinner } from "./controls";

export const MODES: { value: AccessMode; label: string }[] = [
  { value: "approve", label: "Approve each write" },
  { value: "read_only", label: "Read only" },
];

/** Certificate files by drag-and-drop or picking: a .pem + its .key (a lone
 *  .pem brings the .key beside it), or a .p12, which then asks for its password. */
export function CertificateForm({ identity, onChanged }: { identity: IdentityStatus; onChanged: () => void }) {
  const [needsPassword, setNeedsPassword] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importPaths = async (paths: string[], pw: string | null = null) => {
    if (!paths.length) return;
    setBusy(true);
    setError(null);
    try {
      await api.importFiles(paths, pw);
      toast.success("Certificate imported");
      setNeedsPassword(null);
      setPassword("");
      onChanged();
    } catch (e) {
      const msg = errText(e);
      if (msg.startsWith("NEEDS_PASSWORD")) setNeedsPassword(paths);
      else setError(msg);
    } finally {
      setBusy(false);
    }
  };
  const drop = useDropFiles((paths) => void importPaths(paths), isCertFile);
  const choose = async () => {
    const files = await pickFiles({
      title: "Choose the certificate and its key (or a .p12)",
      extensions: ["pem", "key", "crt", "cer", "p12", "pfx"],
      multiple: true,
    });
    await importPaths(files);
  };

  return (
    <div className="cert">
      {identity.loaded && (
        <div className="cert-state">
          <ShieldCheck size={16} strokeWidth={1.8} className="ok" />
          <div><b>{identity.label}</b>{identity.fingerprint && <div className="mono dim">{identity.fingerprint}</div>}</div>
        </div>
      )}
      {identity.error && <p className="err">{identity.error}</p>}
      <div ref={drop.ref} {...drop.handlers} className={cx("cert-drop", drop.over && "over")}>
        {busy ? <Spinner /> : <FileKey2 size={22} strokeWidth={1.5} />}
        <b>{identity.loaded ? "Drop a different certificate here" : "Drop the certificate and its key here"}</b>
        <span className="dim">or a <code>.p12</code> export — kept encrypted on this computer, with the key in the OS keychain</span>
        <button className="act" disabled={busy} onClick={choose}><FileKey2 size={14} strokeWidth={1.8} />Choose files…</button>
      </div>
      {error && <p className="err">{error}</p>}
      {needsPassword && (
        <form className="row p12" onSubmit={(e) => { e.preventDefault(); void importPaths(needsPassword, password); }}>
          <KeyRound size={14} strokeWidth={1.8} className="dim" />
          <code>{needsPassword.map(baseName).join(", ")}</code>
          <input type="password" placeholder="Password" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} />
          <button className="act primary" disabled={busy}>Import</button>
          <button type="button" className="act quiet" onClick={() => setNeedsPassword(null)}>Cancel</button>
        </form>
      )}
    </div>
  );
}

const isCertFile = (p: string) => /\.(pem|key|crt|cer|p12|pfx)$/i.test(p);

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
