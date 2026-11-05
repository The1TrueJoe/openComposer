/** Taking over a controller you own, as a guided wizard: install openComposer's certificate
 *  authority on the controller so the certificate it issues is trusted — no dealer account
 *  needed. It writes to the controller and reboots it, so the Review step is the explicit
 *  confirmation before anything happens.
 *
 *  The same wizard is used from the Connect flow (when a controller refuses or can't be
 *  reached, with its address filled in) and from Settings. It is deliberately not an MCP/agent
 *  action — a takeover only ever runs from this explicit, confirmed user flow. */

import { ArrowLeft, ArrowRight, CircleCheck, FolderOpen, KeyRound, Radar, RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errText, type EraProbe, type TakeoverReport } from "../api";
import { Spinner, Switch } from "./controls";
import { pickDir } from "../lib/files";
import { cx, useLoad } from "../lib/ui";

type Phase = "controller" | "access" | "review" | "running" | "done";
const STEPS: { key: Phase; label: string }[] = [
  { key: "controller", label: "Controller" },
  { key: "access", label: "Access" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];

/** OS 4.2+ turns password SSH off, so the owner's Control4 account is needed once to re-enable it. */
const isModern = (os: string) => /^(4\.[2-9]|[5-9])/.test(os.trim());

/** The controller's MAC is in its SDDP/host name (e.g. "Test-EA1-000FFF1AFCA9") and its TLS
 *  cert CN — the derived-password login needs it, so pull it from the name when we have one. */
function macFromName(name?: string): string {
  const hex = name?.match(/[0-9A-Fa-f]{12}/)?.[0];
  return hex ? (hex.match(/../g) ?? []).join(":").toUpperCase() : "";
}

/** A representative version for an auto-detected era, enough to pick the takeover path (the exact
 *  version isn't knowable without the certificate). The owner can still type the real one. */
const versionForEra = (era: EraProbe["era"]) => (era === "modern" ? "4.2.1" : era === "older" ? "3.3.0" : "");

export function TakeoverWizard({ host: initialHost, name, onCancel, onConnect, refreshStatus }: {
  /** Address the Connect flow couldn't reach/connect to; empty when opened fresh. */
  host: string;
  /** The controller's name, if known — its MAC is lifted from it for the derived-password login. */
  name?: string;
  /** Leave the wizard without connecting (Back out, or Finish after a takeover). */
  onCancel: () => void;
  /** The takeover succeeded — try the controller again. Null hides the "Connect now" button
   *  (e.g. opened from Settings, where there's nothing to return to). */
  onConnect: (() => void) | null;
  refreshStatus: () => void;
}) {
  const ca = useLoad(() => api.takeoverStatus(), []);
  const [phase, setPhase] = useState<Phase>("controller");
  const [host, setHost] = useState(initialHost);
  const [osVersion, setOsVersion] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [dealer, setDealer] = useState("");
  const [mac, setMac] = useState(() => macFromName(name));
  const [reboot, setReboot] = useState(true);
  const [mqtt, setMqtt] = useState(false);
  const [report, setReport] = useState<TakeoverReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [probe, setProbe] = useState<EraProbe | null>(null);

  const modern = isModern(osVersion);

  const detect = async () => {
    if (!host.trim()) return;
    setDetecting(true);
    setProbe(null);
    try {
      const p = await api.probeController(host.trim());
      setProbe(p);
      if (p.era !== "unknown") setOsVersion(versionForEra(p.era));
      if (!p.reachable) toast.error(`Couldn't reach SSH on ${host.trim()} to detect the firmware — enter the OS version, or check it's reachable.`);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setDetecting(false);
    }
  };
  const haveController = host.trim() !== "" && osVersion.trim() !== "";
  const haveAccess = !modern || (email.trim() !== "" && password !== "");

  const at = STEPS.findIndex((s) => s.key === (phase === "running" ? "review" : phase));

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
    setPhase("running");
    setError(null);
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
      refreshStatus();
      setPhase("done");
    } catch (e) {
      const msg = errText(e);
      setError(msg);
      toast.error(msg);
      setPhase("review");
    }
  };

  return (
    <div className="takeover-wiz">
      <ol className="wizard-steps">
        {STEPS.map((s, i) => (
          <li key={s.key} className={cx(i === at && "on", i < at && "done")}>
            <span className="wizard-n">{i < at ? <CircleCheck size={12} strokeWidth={2.2} /> : i + 1}</span>{s.label}
          </li>
        ))}
      </ol>

      {phase === "controller" && <>
        <h1><span className="row nowrap"><ShieldCheck size={18} strokeWidth={1.8} />Take over a controller</span></h1>
        <p className="lede">
          openComposer installs its own certificate authority on a controller you own, so the certificate it
          issues is trusted. Do this only on hardware you own — it changes the controller and reboots it.
        </p>
        <div className="kv">
          <span className="k">Authority</span>
          <span className="row">
            {ca.loading && !ca.data && <Spinner />}
            {ca.data?.has_ca
              ? <><CircleCheck size={14} strokeWidth={1.8} className="ok" /><span>{ca.data.ca_cn ?? "CA ready"}</span><span className="dim small">{ca.data.ca_label}</span></>
              : <span className="dim">None yet — one is generated on the first takeover.</span>}
            <button className="link" onClick={adopt}><FolderOpen size={12} strokeWidth={1.8} /> adopt existing</button>
          </span>
          <span className="k">Address</span>
          <span className="row">
            <input className="mono" value={host} placeholder="192.168.1.172" aria-label="Controller address"
                   onChange={(e) => { setHost(e.target.value); setProbe(null); }} />
            <button className="act small" disabled={!host.trim() || detecting} onClick={detect}
                    title="Read the controller's SSH to tell its firmware era — no certificate needed">
              {detecting ? <Spinner /> : <Radar size={13} strokeWidth={1.8} />}Detect
            </button>
          </span>
          <span className="k">Firmware</span>
          <span className="row">
            <input className="mono narrow" value={osVersion} placeholder="3.3.0" aria-label="OS version"
                   onChange={(e) => setOsVersion(e.target.value)} />
            {probe?.era === "older" ? <span className="dim small"><CircleCheck size={12} strokeWidth={1.8} className="ok" /> detected pre-4.2 (SSH password login{probe.banner ? ` · ${probe.banner}` : ""}) — root over SSH</span>
              : probe?.era === "modern" ? <span className="dim small"><CircleCheck size={12} strokeWidth={1.8} className="ok" /> detected OS 4.2+ (SSH key-only) — needs your Control4 account next</span>
              : probe && !probe.reachable ? <span className="dim small">SSH didn't answer — type the OS version, or check the controller is reachable</span>
              : osVersion.trim() === "" ? <span className="dim small">Detect it, or type the version (from Composer or the About screen)</span>
              : <span className="dim small">{modern ? "OS 4.2+ — needs your Control4 account next" : "older firmware — root over SSH"}</span>}
          </span>
          {mac && <>
            <span className="k">MAC</span>
            <span className="row"><span className="mono">{mac}</span><span className="dim small">from the controller's name — used for the default root password</span></span>
          </>}
        </div>
        <div className="connect-foot end">
          <button className="act quiet" onClick={onCancel}><ArrowLeft size={14} strokeWidth={1.8} />Back</button>
          <button className="act primary" disabled={!haveController} onClick={() => setPhase("access")}>Next<ArrowRight size={14} strokeWidth={1.8} /></button>
        </div>
      </>}

      {phase === "access" && <>
        <h1>How openComposer signs in</h1>
        {modern ? <>
          <p className="lede">
            On OS 4.2+ password SSH is off, so your Control4 account is used <b>once</b> to re-enable it. It's
            sent only to this controller and never stored.
          </p>
          <div className="kv">
            <span className="k">Email</span>
            <input value={email} placeholder="you@example.com" aria-label="Control4 account email"
                   autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
            <span className="k">Password</span>
            <input type="password" value={password} aria-label="Control4 account password"
                   autoComplete="off" onChange={(e) => setPassword(e.target.value)} />
          </div>
        </> : <>
          <p className="lede">
            On older firmware openComposer logs in as root over SSH using the controller's default credentials —
            nothing to enter. If a dealer set a root password, or you want to force the MAC-derived default, add it below.
          </p>
          <details className="advanced">
            <summary>Advanced: a known root password or MAC</summary>
            <div className="kv">
              <span className="k">Root password</span>
              <input type="password" value={dealer} placeholder="if a dealer set one" aria-label="Root password"
                     autoComplete="off" onChange={(e) => setDealer(e.target.value)} />
              <span className="k">MAC</span>
              <input className="mono" value={mac} placeholder="00:0F:FF:…  (for the derived default)" aria-label="MAC address"
                     onChange={(e) => setMac(e.target.value)} />
            </div>
          </details>
        </>}
        <div className="connect-foot end">
          <button className="act quiet" onClick={() => setPhase("controller")}><ArrowLeft size={14} strokeWidth={1.8} />Back</button>
          <button className="act primary" disabled={!haveAccess} onClick={() => setPhase("review")}>Next<ArrowRight size={14} strokeWidth={1.8} /></button>
        </div>
      </>}

      {(phase === "review" || phase === "running") && <>
        <h1>Review</h1>
        <p className="lede">
          openComposer will log into <span className="mono">{host.trim()}</span>, add its certificate authority to the
          controller's trust store{reboot ? ", and reboot the controller" : " (no reboot — the change won't take effect until it reboots)"}.
        </p>
        <div className="kv">
          <span className="k">Controller</span>
          <span><span className="mono">{host.trim()}</span> <span className="dim small">OS {osVersion.trim()} · {modern ? "OS 4.2+" : "older firmware"}</span></span>
          <span className="k">Reboot</span>
          <label className="inline-switch">
            <Switch checked={reboot} onCheckedChange={setReboot} disabled={phase === "running"} label="Reboot the controller when a trust file changed" />
            {reboot ? "Reboot when done (needed for the change to take effect)" : "Don't reboot (you'll reboot it yourself later)"}
          </label>
          {modern && <>
            <span className="k">MQTT bus</span>
            <label className="inline-switch">
              <Switch checked={mqtt} onCheckedChange={setMqtt} disabled={phase === "running"} label="Also set up the OS 4.2 message bus" />
              {mqtt ? "Also patch api.pem so the message bus accepts openComposer" : "Leave the message bus alone — the certificate swap is enough for the main connection"}
            </label>
          </>}
        </div>
        <p className="hint"><TriangleAlert size={13} strokeWidth={1.8} /> This changes the controller{reboot ? " and reboots it" : ""}. The original trust files are backed up on the controller and on this computer.</p>
        {error && <p className="err">{error}</p>}
        <div className="connect-foot end">
          <button className="act quiet" disabled={phase === "running"} onClick={() => setPhase("access")}><ArrowLeft size={14} strokeWidth={1.8} />Back</button>
          <button className="act danger" disabled={phase === "running"} onClick={run}>
            {phase === "running" ? <Spinner /> : <ShieldCheck size={14} strokeWidth={1.8} />}
            {phase === "running" ? "Taking over…" : "Take over"}
          </button>
        </div>
      </>}

      {phase === "done" && report && <>
        <h1><span className="row nowrap"><CircleCheck size={18} strokeWidth={1.8} className="ok" />Took over {host.trim()}</span></h1>
        <p className="lede">
          {report.issued_cn
            ? <>Imported the client certificate <span className="mono">{report.issued_cn}</span>. {report.rebooted ? "The controller is rebooting — it'll be back in a few minutes." : report.patched.length ? "Reboot it for the change to take effect." : "Nothing needed changing."}</>
            : <>Done.</>}
        </p>
        <div className="kv">
          <span className="k">Result</span>
          <span className="row"><CircleCheck size={14} strokeWidth={1.8} className="ok" /> {report.era} controller</span>
          {report.mqtt_patched && <><span className="k">MQTT</span><span>api.pem patched — the message bus will accept openComposer</span></>}
          {report.patched.length > 0 && <><span className="k">Patched</span><span className="col">{report.patched.map((p) => <span key={p} className="mono small">{p}</span>)}</span></>}
          {report.already_patched.length > 0 && <><span className="k">Already</span><span className="col">{report.already_patched.map((p) => <span key={p} className="mono small dim">{p}</span>)}</span></>}
          {report.missing.length > 0 && <><span className="k">Not present</span><span className="col">{report.missing.map((p) => <span key={p} className="mono small dim">{p}</span>)}</span></>}
        </div>
        <div className="connect-foot end">
          <button className="act quiet" onClick={onCancel}>Done</button>
          {onConnect && (
            <button className="act primary" onClick={onConnect} disabled={report.rebooted}
                    title={report.rebooted ? "Wait for the controller to finish rebooting, then connect" : undefined}>
              <KeyRound size={14} strokeWidth={1.8} />{report.rebooted ? "Rebooting…" : "Connect now"}
            </button>
          )}
        </div>
        {report.rebooted && <p className="hint">The controller is rebooting — reconnect from the controller list once it's back.</p>}
      </>}
    </div>
  );
}

/** Undoing a takeover: remove openComposer's CA from the controller's trust chains and reboot.
 *  Advanced and rare, so it stays compact and behind a disclosure. */
function RevertForm({ refreshStatus }: { refreshStatus: () => void }) {
  const [host, setHost] = useState("");
  const [osVersion, setOsVersion] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reboot, setReboot] = useState(true);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const modern = isModern(osVersion);
  const canRun = host.trim() !== "" && osVersion.trim() !== "" && (!modern || (email.trim() && password));

  const revert = async () => {
    setBusy(true);
    try {
      await api.revert({
        host: host.trim(), os_version: osVersion.trim(),
        account_email: email.trim() || null, account_password: password || null,
        dealer_password: null, mac: null, reboot,
      });
      setPassword("");
      setArmed(false);
      toast.success(`Reverted the takeover on ${host.trim()}`);
      refreshStatus();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="advanced">
      <summary>Undo a takeover</summary>
      <p className="hint flush">Removes openComposer's certificate authority from the controller's trust store and reboots it. The client certificate it imported stays.</p>
      <div className="kv">
        <span className="k">Address</span>
        <input className="mono" value={host} placeholder="192.168.1.172" aria-label="Controller address" onChange={(e) => setHost(e.target.value)} />
        <span className="k">OS version</span>
        <input className="mono narrow" value={osVersion} placeholder="3.3.0" aria-label="OS version" onChange={(e) => setOsVersion(e.target.value)} />
        {modern && <>
          <span className="k">Email</span>
          <input value={email} placeholder="you@example.com" aria-label="Control4 account email" autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
          <span className="k">Password</span>
          <input type="password" value={password} aria-label="Control4 account password" autoComplete="off" onChange={(e) => setPassword(e.target.value)} />
        </>}
        <span className="k">Reboot</span>
        <label className="inline-switch"><Switch checked={reboot} onCheckedChange={setReboot} label="Reboot after reverting" />{reboot ? "Reboot when done" : "Don't reboot"}</label>
      </div>
      <div className="row" style={{ marginTop: "0.5rem" }}>
        {!armed
          ? <button className="act" disabled={!canRun} onClick={() => setArmed(true)}><RotateCcw size={13} strokeWidth={1.8} />Undo takeover…</button>
          : <>
              <button className="act danger" disabled={busy} onClick={revert}>{busy ? <Spinner /> : <RotateCcw size={13} strokeWidth={1.8} />}{busy ? "Undoing…" : `Undo on ${host.trim()}`}</button>
              <button className="act quiet" disabled={busy} onClick={() => setArmed(false)}>Cancel</button>
            </>}
      </div>
    </details>
  );
}

/** The Settings entry: launch the takeover wizard in place, with the rare "undo" tucked away. */
export function TakeoverLauncher({ refreshStatus }: { refreshStatus: () => void }) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <section className="card" id="takeover">
        <TakeoverWizard host="" onCancel={() => setOpen(false)} onConnect={null} refreshStatus={refreshStatus} />
      </section>
    );
  }
  return (
    <section className="card" id="takeover">
      <h3>Take over a controller</h3>
      <p className="hint flush">
        Install openComposer's own certificate authority on a controller you own, so the certificate it
        issues is trusted — no dealer account needed. It changes the controller and reboots it, so only do
        this on hardware you own.
      </p>
      <button className="act" onClick={() => setOpen(true)}><ShieldCheck size={14} strokeWidth={1.8} />Take over a controller…</button>
      <RevertForm refreshStatus={refreshStatus} />
    </section>
  );
}
