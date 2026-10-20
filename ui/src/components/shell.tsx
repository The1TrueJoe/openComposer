/** The app's chrome around the pages: the Director picker in the top bar, the status bar,
 *  and the panel a page shows when it can't load. The connect screen is in connect.tsx. */

import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Lock, Plug, PlugZap, RefreshCw, Settings2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errText, isMock, type AppStatus, type DirectorInfo } from "../api";
import { cx } from "../lib/ui";
import { Spinner } from "./controls";

export function Logo() {
  return (
    <span className="brand">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="9" fill="none" stroke="var(--accent)" strokeWidth="2.2" />
        <path d="M8 12h8M12 8v8" stroke="var(--text)" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      <span>open<b>Composer</b></span>
    </span>
  );
}

export function DirectorPicker({ status, info, onManage, onSwitch }: {
  status: AppStatus; info: Map<string, DirectorInfo>; onManage: () => void; onSwitch: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { directors, active_director } = status.config;
  const active = directors.find((d) => d.id === active_director) ?? null;
  const isOn = (id: string) => status.connected.includes(id);

  const run = async (id: string, f: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await f();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="dpick" aria-label="Director">
          <span className={cx("dot", active && isOn(active.id) && "on")} />
          <span className="dpick-name">{active?.name ?? "No Director"}</span>
          {active && info.get(active.id) && <span className="dim">{info.get(active.id)!.version}</span>}
          {active && <span className={cx("tag", active.mode === "approve" ? "accent" : "")}>{active.mode === "approve" ? "approve" : "read only"}</span>}
          <ChevronDown size={13} strokeWidth={1.8} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="pop dpick-pop" align="end" sideOffset={6}>
          <div className="group">Directors</div>
          {!directors.length && <p className="empty pad">None set up yet.</p>}
          {directors.map((d) => (
            <div key={d.id} className={cx("dpick-row", d.id === active_director && "on")}>
              <button className="dpick-choose" onClick={() => run(d.id, () => api.setActiveDirector(d.id))}>
                <span className="dpick-check">{d.id === active_director && <Check size={13} strokeWidth={1.8} />}</span>
                <span className={cx("dot", isOn(d.id) && "on")} />
                <span className="dpick-text">
                  <b>{d.name}</b>
                  <span className="dim mono">{d.host}{info.get(d.id) ? ` · ${info.get(d.id)!.version}` : ""}</span>
                </span>
                {d.mode === "read_only" && <Lock size={12} strokeWidth={1.8} className="dim" />}
              </button>
              {busy === d.id ? <Spinner /> : isOn(d.id)
                ? <button className="act small" onClick={() => run(d.id, () => api.disconnect(d.id))}><PlugZap size={13} strokeWidth={1.8} />Disconnect</button>
                : <button className="act small" onClick={() => run(d.id, () => api.connect(d.id))}><Plug size={13} strokeWidth={1.8} />Connect</button>}
            </div>
          ))}
          <button className="pop-link" onClick={() => { setOpen(false); onSwitch(); }}><Plug size={13} strokeWidth={1.8} />Switch Director…</button>
          <button className="pop-link" onClick={() => { setOpen(false); onManage(); }}><Settings2 size={13} strokeWidth={1.8} />Manage Directors…</button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function StatusBar({ status, info }: { status: AppStatus; info: DirectorInfo | null }) {
  const { mcp, identity } = status;
  const active = status.config.directors.find((d) => d.id === status.config.active_director);
  return (
    <footer className="status">
      <span className="status-item" title={mcp.error ?? "MCP server for Claude Code, Codex and other clients"}>
        <span className={cx("dot", mcp.listening && "on", mcp.error && "bad")} />
        MCP {mcp.listening ? <span className="mono">{mcp.url}</span> : <span className="err">{mcp.error ?? "stopped"}</span>}
      </span>
      {active && (
        <span className="status-item">
          <span className={cx("dot", status.connected.includes(active.id) && "on")} />
          {active.name}{info && <span className="dim"> · OS {info.version}</span>}
        </span>
      )}
      {isMock && <span className="status-item warn">Mock backend — fixture data, nothing leaves this browser</span>}
      <span className="status-item spread">{identity.loaded ? identity.label : <span className="warn">No certificate</span>}</span>
      <span className="status-item dim">v{status.version}</span>
    </footer>
  );
}

/** A page that couldn't load: the backend's own sentence, and a way to try again. */
export function Failure({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="failure">
      <p className="err">{error}</p>
      {retry && <button className="act" onClick={retry}><RefreshCw size={14} strokeWidth={1.8} />Try again</button>}
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <p className="loading"><Spinner />{what}…</p>;
}
