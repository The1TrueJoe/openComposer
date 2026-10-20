import { Eye, EyeOff, Fingerprint, Plug, PlugZap, RefreshCw, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, errText, type AccessMode, type Provider, type SavedDirector } from "../../api";
import { Tip, useDialog } from "../../components/Dialogs";
import { CopyButton, Select, Snippet, Spinner, Switch } from "../../components/controls";
import { AddDirectorForm, CertificateForm, MODES } from "../../components/setup";
import type { Shell } from "../../lib/shell";
import { cx, useLoad } from "../../lib/ui";

export function SettingsPage({ shell }: { shell: Shell }) {
  return (
    <div className="pane settings">
      <section className="card" id="certificate">
        <h3>Certificate</h3>
        <p className="hint flush">The client certificate Directors trust — the one Composer Pro uses.</p>
        <CertificateForm identity={shell.status.identity} onChanged={shell.refreshStatus} />
      </section>
      <Directors shell={shell} />
      <Mcp shell={shell} />
      <Agent shell={shell} />
    </div>
  );
}

// ---- Directors -----------------------------------------------------------------------------

function Directors({ shell }: { shell: Shell }) {
  const { directors, active_director } = shell.status.config;
  return (
    <section className="card" id="directors">
      <h3>Directors</h3>
      <p className="hint flush">“Approve each write” lets MCP clients, the agent and this app propose changes that you approve on a diff; “read only” refuses every change.</p>
      {directors.map((d) => <DirectorRow key={d.id} d={d} active={d.id === active_director} connected={shell.status.connected.includes(d.id)} />)}
      {!directors.length && <p className="empty">No Directors yet.</p>}
      <div className="section flush">Add a Director</div>
      <AddDirectorForm onAdded={() => {}} />
    </section>
  );
}

function DirectorRow({ d, active, connected }: { d: SavedDirector; active: boolean; connected: boolean }) {
  const [name, setName] = useState(d.name);
  const [host, setHost] = useState(d.host);
  const [webAddr, setWebAddr] = useState(d.web_api_addr ?? "");
  const [busy, setBusy] = useState(false);
  const { confirm } = useDialog();
  useEffect(() => { setName(d.name); setHost(d.host); setWebAddr(d.web_api_addr ?? ""); }, [d.name, d.host, d.web_api_addr]);

  const run = async (f: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await f();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const save = (patch: { name?: string; host?: string; mode?: AccessMode; webApi?: boolean; webApiAddr?: string }) =>
    run(() => api.updateDirector(d.id, patch));

  return (
    <div className={cx("dir", active && "active")}>
      <div className="dir-top">
        <span className={cx("dot", connected && "on")} title={connected ? "Connected" : "Not connected"} />
        <input className="dir-name" value={name} aria-label="Name" onChange={(e) => setName(e.target.value)}
               onBlur={() => name.trim() && name !== d.name && save({ name: name.trim() })} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        <input className="dir-host mono" value={host} aria-label="Host" onChange={(e) => setHost(e.target.value)}
               onBlur={async () => {
                 if (!host.trim() || host === d.host) return;
                 // A new address is probably a new controller: its certificate is re-pinned on connect.
                 if (await confirm({ title: `Change ${d.name}'s address to ${host.trim()}?`, description: "It will be disconnected, and the controller certificate pinned for the old address is forgotten.", confirmLabel: "Change" })) {
                   void save({ host: host.trim() });
                 } else setHost(d.host);
               }} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        <Select value={d.mode} onValueChange={(mode) => save({ mode })} options={MODES} label="Access" />
        {busy && <Spinner />}
      </div>
      <div className="dir-bottom">
        {active
          ? <span className="tag accent"><Star size={10} strokeWidth={2} /> active</span>
          : <button className="act small" onClick={() => run(() => api.setActiveDirector(d.id))}>Make active</button>}
        {connected
          ? <button className="act small" onClick={() => run(() => api.disconnect(d.id))}><PlugZap size={13} strokeWidth={1.8} />Disconnect</button>
          : <button className="act small" onClick={() => run(() => api.connect(d.id), `Connected to ${d.name}`)}><Plug size={13} strokeWidth={1.8} />Connect</button>}
        <span className="dir-fp">
          <Fingerprint size={13} strokeWidth={1.8} />
          {d.fingerprint ? <><span className="mono">{d.fingerprint.slice(0, 23)}{d.fingerprint.length > 23 ? "…" : ""}</span>
            <Tip text="Forget the pinned controller certificate (after replacing or resetting the controller)">
              <button className="act small quiet" onClick={async () => {
                if (await confirm({ title: `Forget ${d.name}'s pinned certificate?`, description: "The next connection will trust whatever certificate the controller presents, and pin that one.", confirmLabel: "Forget" })) {
                  void run(() => api.forgetFingerprint(d.id), "Pinned certificate forgotten");
                }
              }}>Forget</button>
            </Tip></> : <span className="dim">pinned on first connect</span>}
        </span>
        <button className="act small danger spread" onClick={async () => {
          if (await confirm({ title: `Remove ${d.name}?`, description: "Only openComposer's settings for it are removed; nothing on the controller changes.", confirmLabel: "Remove", danger: true })) {
            void run(() => api.removeDirector(d.id));
          }
        }}><Trash2 size={13} strokeWidth={1.8} />Remove</button>
      </div>
      <div className="dir-web">
        <label className="inline-switch">
          <Switch checked={d.web_api} onCheckedChange={(webApi) => save({ webApi })} label="Use controller web API" />
          Use controller web API (driver files)
        </label>
        {d.web_api && (
          <>
            <input className="mono" value={webAddr} placeholder={`${d.host}:443`} aria-label="Web API address"
                   onChange={(e) => setWebAddr(e.target.value)}
                   onBlur={() => webAddr.trim() !== (d.web_api_addr ?? "") && save({ webApiAddr: webAddr.trim() })}
                   onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
            <span className="dim small">blank = host:443; a Virtual Director uses 127.0.0.1:8443 on its own PC</span>
            {d.web_api_fingerprint && <span className="dim small mono" title="Pinned web API certificate">{d.web_api_fingerprint.slice(0, 23)}…</span>}
          </>
        )}
      </div>
    </div>
  );
}

// ---- MCP -----------------------------------------------------------------------------------

function Mcp({ shell }: { shell: Shell }) {
  const { mcp, config, stdio_command } = shell.status;
  const [port, setPort] = useState(String(config.mcp.port));
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const { confirm } = useDialog();
  useEffect(() => setPort(String(config.mcp.port)), [config.mcp.port]);

  const update = async (p: { port?: number; lan?: boolean; newToken?: boolean }) => {
    setBusy(true);
    try {
      await api.updateMcp(p);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const token = config.mcp.token;
  const hidden = "•".repeat(12);
  const t = (s: string) => s.replaceAll(token, hidden);
  const claude = `claude mcp add --transport http openComposer ${mcp.url} --header "Authorization: Bearer ${token}"`;
  const codex = `[mcp_servers.openComposer]\ncommand = ${JSON.stringify(stdio_command)}\nargs = ["--mcp-stdio"]`;
  const generic = JSON.stringify({ mcpServers: { openComposer: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  const portValid = /^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535;

  return (
    <section className="card" id="mcp">
      <h3>MCP server</h3>
      <p className="hint flush">Claude Code, Codex and any other MCP client get the same tools as the in-app agent. Changes they propose still need your approval here.</p>
      <div className="kv">
        <span className="k">Status</span>
        <span className="row">
          <span className={cx("dot", mcp.listening && "on")} />
          {mcp.listening ? <><span className="mono">{mcp.url}</span><CopyButton text={mcp.url} label="Copy URL" /></> : <span className="err">{mcp.error ?? "Not listening"}</span>}
          {busy && <Spinner />}
        </span>
        <span className="k">Network</span>
        <label className="inline-switch">
          <Switch checked={config.mcp.lan} onCheckedChange={(lan) => update({ lan })} label="Listen on the local network" />
          {config.mcp.lan ? "Reachable from other computers on this network (token required)" : "This computer only (127.0.0.1)"}
        </label>
        <span className="k">Port</span>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (portValid) void update({ port: Number(port) }); }}>
          <input className="mono narrow" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" aria-label="Port" />
          <button className="act small" disabled={!portValid || Number(port) === config.mcp.port}>Apply</button>
          {!portValid && <span className="err small">1024–65535</span>}
        </form>
        <span className="k">Token</span>
        <span className="row">
          <code className="token">{reveal ? token : hidden}</code>
          <Tip text={reveal ? "Hide" : "Reveal"}><button className="icon-btn" aria-label={reveal ? "Hide token" : "Reveal token"} onClick={() => setReveal(!reveal)}>
            {reveal ? <EyeOff size={14} strokeWidth={1.8} /> : <Eye size={14} strokeWidth={1.8} />}</button></Tip>
          <CopyButton text={token} />
          <button className="act small danger" onClick={async () => {
            if (await confirm({ title: "Regenerate the MCP token?", description: "Every configured client stops working until it is given the new token.", confirmLabel: "Regenerate", danger: true })) {
              void update({ newToken: true });
            }
          }}><RefreshCw size={13} strokeWidth={1.8} />Regenerate</button>
        </span>
      </div>
      <div className="section flush">Connect a client</div>
      <Snippet title="Claude Code — run in a terminal" text={claude} shown={reveal ? claude : t(claude)} />
      <Snippet title="Codex — ~/.codex/config.toml (stdio bridge; this app must be running)" text={codex} />
      <Snippet title="Other clients — JSON" text={generic} shown={reveal ? generic : t(generic)} />
    </section>
  );
}

// ---- the agent -----------------------------------------------------------------------------

function Agent({ shell }: { shell: Shell }) {
  const a = shell.status.config.agent;
  const providers = useLoad(() => api.agentProviders(), [a.claude_path, a.codex_path]);
  const [claudePath, setClaudePath] = useState(a.claude_path ?? "");
  const [codexPath, setCodexPath] = useState(a.codex_path ?? "");
  const [model, setModel] = useState(a.model ?? "");

  const save = (p: { provider?: Provider; claudePath?: string; codexPath?: string; model?: string }) =>
    api.updateAgent(p).catch((e) => toast.error(errText(e)));
  const field = (label: string, value: string, set: (s: string) => void, current: string, key: "claudePath" | "codexPath" | "model", placeholder: string) => (
    <>
      <span className="k">{label}</span>
      <input className="mono" value={value} placeholder={placeholder} onChange={(e) => set(e.target.value)}
             onBlur={() => value.trim() !== current && save({ [key]: value.trim() })} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
    </>
  );

  return (
    <section className="card" id="agent">
      <h3>Agent</h3>
      <p className="hint flush">The Agent tab drives your own Claude Code or Codex CLI, signed in with your own subscription. It gets openComposer's tools and nothing else — no shell, no files.</p>
      <div className="kv">
        <span className="k">Default</span>
        <Select value={a.provider} onValueChange={(provider) => save({ provider })} label="Default agent"
                options={[{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }]} />
        <span className="k">Installed</span>
        <span className="providers">
          {providers.loading && !providers.data && <Spinner />}
          {providers.data?.map((p) => (
            <span key={p.provider} className="row">
              <span className={cx("dot", p.installed && "on")} />
              <b>{p.provider === "claude" ? "Claude Code" : "Codex"}</b>
              {p.installed ? <><span className="dim">{p.version}</span><span className="mono dim small">{p.path}</span></> : <span className="dim">not found</span>}
            </span>
          ))}
        </span>
        {field("Claude path", claudePath, setClaudePath, a.claude_path ?? "", "claudePath", "found on PATH")}
        {field("Codex path", codexPath, setCodexPath, a.codex_path ?? "", "codexPath", "found on PATH")}
        {field("Model", model, setModel, a.model ?? "", "model", "the CLI's default")}
      </div>
    </section>
  );
}
