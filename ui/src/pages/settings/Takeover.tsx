import { CircleCheck, FolderOpen, RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errText, type TakeoverReport } from "../../api";
import { useDialog } from "../../components/Dialogs";
import { Spinner, Switch } from "../../components/controls";
import { pickDir } from "../../lib/files";
import type { Shell } from "../../lib/shell";
import { useLoad } from "../../lib/ui";

/** Taking over a controller you own: install openComposer's CA so its certificate is
 *  trusted. Writes to the controller and reboots it, so every run is confirmed first. */
export function Takeover({ shell }: { shell: Shell }) {
  const ca = useLoad(() => api.takeoverStatus(), []);
  const { confirm } = useDialog();

  const [host, setHost] = useState("");
  const [osVersion, setOsVersion] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [dealer, setDealer] = useState("");
  const [mac, setMac] = useState("");
  const [reboot, setReboot] = useState(true);
  const [mqtt, setMqtt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<TakeoverReport | null>(null);
  const [reverting, setReverting] = useState(false);

  // OS 4.2+ needs the account sign-in to re-enable SSH; show that need as the person types.
  const modern = /^(4\.[2-9]|[5-9])/.test(osVersion.trim());
  const canRun = host.trim() !== "" && osVersion.trim() !== "" && (!modern || (email.trim() && password));

  const adopt = async () => {
    const folder = await pickDir("Choose the Control4 “Certs” folder (with public.pem and private.key)");
    if (!folder) return;
    try {
      const cn = await api.adoptGaryCa(folder);
      toast.success(`Adopted CA “${cn}”`);
      ca.reload();
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const run = async () => {
    const ok = await confirm({
      title: `Take over ${host.trim()}?`,
      description:
        "openComposer will log into the controller, add its certificate authority to the controller's " +
        "trust store" +
        (reboot ? ", and reboot the controller" : " (no reboot — the change won't take effect until it reboots)") +
        ". Do this only on a controller you own. The original trust files are backed up on the controller and on this computer.",
      confirmLabel: "Take over",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setReport(null);
    try {
      const r = await api.takeOver({
        host: host.trim(),
        os_version: osVersion.trim(),
        account_email: email.trim() || null,
        account_password: password || null,
        dealer_password: dealer || null,
        mac: mac.trim() || null,
        reboot,
        mqtt: modern && mqtt,
      });
      setReport(r);
      setPassword("");
      toast.success(`Took over ${host.trim()} — client certificate imported`);
      shell.refreshStatus();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    const ok = await confirm({
      title: `Undo the takeover on ${host.trim()}?`,
      description:
        "openComposer will remove its certificate authority from the controller's trust store" +
        (modern ? ", remove the MQTT signing certificate, turn password SSH back off," : "") +
        (reboot ? " and reboot the controller." : " (no reboot — the change won't take effect until it reboots).") +
        " The client certificate it imported stays; remove it above if you no longer want it.",
      confirmLabel: "Undo takeover",
      danger: true,
    });
    if (!ok) return;
    setReverting(true);
    setReport(null);
    try {
      const r = await api.revert({
        host: host.trim(),
        os_version: osVersion.trim(),
        account_email: email.trim() || null,
        account_password: password || null,
        dealer_password: dealer || null,
        mac: mac.trim() || null,
        reboot,
      });
      setReport(r);
      setPassword("");
      toast.success(`Reverted the takeover on ${host.trim()}`);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setReverting(false);
    }
  };

  return (
    <section className="card" id="takeover">
      <h3>Take over a controller</h3>
      <p className="hint flush">
        Install openComposer's own certificate authority on a controller you own, so the certificate it
        issues is trusted — no dealer account needed. It changes the controller and reboots it, so only do
        this on hardware you own.
      </p>

      <div className="kv">
        <span className="k">Authority</span>
        <span className="row">
          {ca.loading && !ca.data && <Spinner />}
          {ca.data?.has_ca
            ? <><CircleCheck size={14} strokeWidth={1.8} className="ok" /><span>{ca.data.ca_cn ?? "CA ready"}</span><span className="dim small">{ca.data.ca_label}</span></>
            : <span className="dim">None yet — one is generated on the first takeover, or adopt an existing one.</span>}
        </span>
        <span className="k" />
        <span className="row">
          <button className="act small" onClick={adopt}><FolderOpen size={13} strokeWidth={1.8} />Adopt existing CA folder</button>
          <span className="dim small">a Control4 “Certs” folder with public.pem + private.key</span>
        </span>
      </div>

      <div className="section flush">Controller</div>
      <div className="kv">
        <span className="k">Address</span>
        <input className="mono" value={host} placeholder="192.168.1.172" aria-label="Controller address"
               onChange={(e) => setHost(e.target.value)} />
        <span className="k">OS version</span>
        <span className="row">
          <input className="mono narrow" value={osVersion} placeholder="4.2.1" aria-label="OS version"
                 onChange={(e) => setOsVersion(e.target.value)} />
          <span className="dim small">{osVersion.trim() === "" ? "from the controller (Discover)" : modern ? "OS 4.2+ — needs your Control4 account below" : "older firmware — password/SSH takeover"}</span>
        </span>
      </div>

      {modern && (
        <>
          <div className="section flush">Your Control4 account <span className="dim small">(OS 4.2+ only — used once to re-enable SSH, never stored)</span></div>
          <div className="kv">
            <span className="k">Email</span>
            <input value={email} placeholder="you@example.com" aria-label="Control4 account email"
                   autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
            <span className="k">Password</span>
            <input type="password" value={password} aria-label="Control4 account password"
                   autoComplete="off" onChange={(e) => setPassword(e.target.value)} />
          </div>
        </>
      )}

      <details className="advanced">
        <summary>Advanced: a known root password or MAC (older firmware)</summary>
        <div className="kv">
          <span className="k">Root password</span>
          <input type="password" value={dealer} placeholder="if a dealer set one" aria-label="Root password"
                 autoComplete="off" onChange={(e) => setDealer(e.target.value)} />
          <span className="k">MAC</span>
          <input className="mono" value={mac} placeholder="00:0F:FF:…  (for the derived default)" aria-label="MAC address"
                 onChange={(e) => setMac(e.target.value)} />
        </div>
      </details>

      <div className="kv">
        <span className="k">Reboot</span>
        <label className="inline-switch">
          <Switch checked={reboot} onCheckedChange={setReboot} label="Reboot the controller if a trust file changed" />
          {reboot ? "Reboot when done (needed for the change to take effect)" : "Don't reboot (you'll reboot it yourself later)"}
        </label>
      </div>

      {modern && (
        <div className="kv">
          <span className="k">MQTT bus</span>
          <label className="inline-switch">
            <Switch checked={mqtt} onCheckedChange={setMqtt} label="Also set up the OS 4.2 message bus" />
            {mqtt
              ? "Also patch api.pem so the message bus accepts openComposer (restarts the broker plugin, no reboot)"
              : "Leave the message bus alone — the certificate swap is enough for the main connection"}
          </label>
        </div>
      )}

      <div className="row" style={{ marginTop: "0.75rem" }}>
        <button className="act danger" disabled={!canRun || busy || reverting} onClick={run}>
          {busy ? <Spinner /> : <ShieldCheck size={14} strokeWidth={1.8} />}
          {busy ? "Taking over…" : "Take over"}
        </button>
        <button className="act" disabled={!canRun || busy || reverting} onClick={revert}
                title="Undo a previous takeover on this controller">
          {reverting ? <Spinner /> : <RotateCcw size={14} strokeWidth={1.8} />}
          {reverting ? "Undoing…" : "Undo takeover"}
        </button>
        {!canRun && !busy && !reverting && <span className="dim small"><TriangleAlert size={12} strokeWidth={1.8} /> address and OS version{modern ? ", and your Control4 account" : ""} needed</span>}
      </div>

      {report && (
        <div className="kv" style={{ marginTop: "0.5rem" }}>
          <span className="k">Result</span>
          <span className="row"><CircleCheck size={14} strokeWidth={1.8} className="ok" /> {report.era} controller{report.issued_cn ? <> — issued <span className="mono">{report.issued_cn}</span></> : " — takeover undone"}</span>
          {report.mqtt_patched && <><span className="k">MQTT</span><span>api.pem patched — the message bus will accept openComposer</span></>}
          {report.patched.length > 0 && <><span className="k">{report.issued_cn ? "Patched" : "Reverted"}</span><span className="col">{report.patched.map((p) => <span key={p} className="mono small">{p}</span>)}</span></>}
          {report.already_patched.length > 0 && <><span className="k">Already</span><span className="col">{report.already_patched.map((p) => <span key={p} className="mono small dim">{p}</span>)}</span></>}
          {report.missing.length > 0 && <><span className="k">Not present</span><span className="col">{report.missing.map((p) => <span key={p} className="mono small dim">{p}</span>)}</span></>}
          <span className="k">Reboot</span>
          <span>{report.rebooted ? "rebooting — it'll be back in a few minutes" : report.patched.length ? "not rebooted; reboot it for the change to take effect" : "not needed"}</span>
        </div>
      )}
    </section>
  );
}
