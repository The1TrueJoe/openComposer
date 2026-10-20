import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageBoundary } from "./components/PageBoundary";
import { Toaster, toast } from "sonner";
import { api, errText, type AddDriverArgs, type AppStatus, type Approval, type DirectorInfo, type Op, type Outcome, type UiContext } from "./api";
import { ApprovalsBell, ApprovalsDrawer } from "./components/ApprovalsDrawer";
import { Dialogs } from "./components/Dialogs";
import { ConnectScreen } from "./components/connect";
import { McpAuthPrompt } from "./components/McpAuth";
import { DirectorPicker, Failure, Loading, Logo, StatusBar } from "./components/shell";
import { resetDriverIcons } from "./lib/driverIcons";
import { INSPECTOR_TABS, type FocusItem, type InspectorTab, type Shell, type View } from "./lib/shell";
import { useBackendEvent } from "./lib/ui";

// One chunk per tab: only one is on screen, and the agent's markdown and the settings forms
// don't need to be parsed before the project tree can draw.
const DesignPage = lazy(() => import("./pages/design/DesignPage").then((m) => ({ default: m.DesignPage })));
const NetworkPage = lazy(() => import("./pages/network/NetworkPage").then((m) => ({ default: m.NetworkPage })));
const ProgrammingPage = lazy(() => import("./pages/programming/ProgrammingPage").then((m) => ({ default: m.ProgrammingPage })));
const AgentPage = lazy(() => import("./pages/agent/AgentPage").then((m) => ({ default: m.AgentPage })));
const BackupsPage = lazy(() => import("./pages/backups/BackupsPage").then((m) => ({ default: m.BackupsPage })));
const ActivityPage = lazy(() => import("./pages/activity/ActivityPage").then((m) => ({ default: m.ActivityPage })));
const SettingsPage = lazy(() => import("./pages/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));

const VIEWS: { id: View; label: string }[] = [
  { id: "design", label: "Design" },
  { id: "network", label: "Network" },
  { id: "programming", label: "Programming" },
  { id: "agent", label: "Agent" },
  { id: "backups", label: "Backups" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
];

const UI_SOURCE = "You (openComposer)";

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("design");
  const [info, setInfo] = useState<Map<string, DirectorInfo>>(new Map());
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [rev, setRev] = useState(0);
  // Every launch starts at the connect screen, like Composer's "Connect to Director".
  const [entered, setEntered] = useState(false);
  // Proposals made from this window: their card opens by itself, so no toast is needed.
  const ours = useRef(new Set<string>());
  // Design's selection lives here so an assistant's `ui-command` can move it from anywhere.
  const [selected, setSelected] = useState<number | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("properties");
  const [focus, setFocus] = useState<FocusItem | null>(null);
  const [chat, setChat] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    api.status().then((s) => { setStatus(s); setError(null); }, (e) => setError(errText(e)));
  }, []);
  useEffect(() => {
    refreshStatus();
    api.approvals().then(setApprovals, () => {});
    // Sessions that were already up when this window opened sent their `director` event
    // before anyone was listening; ask them again for name and OS version (no reconnect).
    api.status().then((s) => {
      for (const id of s.connected) {
        api.connect(id).then((r) => setInfo((m) => new Map(m).set(id, r.info)), () => {});
      }
    }, () => {});
  }, [refreshStatus]);

  const activeId = status?.config.active_director ?? null;

  useBackendEvent("config", (config) => {
    setStatus((s) => s && { ...s, config });
    // The active Director changing means every page is now about a different project, and an
    // id selected in the old one means nothing in the new one.
    if (config.active_director !== activeId) {
      setRev((r) => r + 1);
      setSelected(null);
      resetDriverIcons();
    }
  });
  useBackendEvent("mcp", (mcp) => setStatus((s) => s && { ...s, mcp }));
  useBackendEvent("director", (d) => {
    setStatus((s) => s && {
      ...s, connected: d.connected ? [...new Set([...s.connected, d.id])] : s.connected.filter((x) => x !== d.id),
    });
    if (d.info) setInfo((m) => new Map(m).set(d.id, d.info!));
  });
  useBackendEvent("project-changed", (p) => { if (p.director === activeId) setRev((r) => r + 1); });
  useBackendEvent("approval", (a) => {
    setApprovals((list) => {
      const i = list.findIndex((x) => x.id === a.id);
      return i < 0 ? [a, ...list] : list.map((x) => (x.id === a.id ? a : x));
    });
    // A change you just asked for: its card is the next thing you want to see.
    if (a.status === "pending" && a.source === UI_SOURCE) {
      ours.current.add(a.id);
      setDrawer(true);
    }
  });
  useBackendEvent("attention", (n) => {
    if (n.kind !== "approval" || ours.current.has(n.id)) return;
    toast.message("A change needs your approval", {
      id: n.id, description: n.title ?? undefined, duration: 10_000,
      action: { label: "Review", onClick: () => setDrawer(true) },
    });
  });

  // An assistant (ui_show) pointing at something. Values it gets wrong are ignored, not obeyed
  // halfway: an unknown view or tab is skipped, the rest still applies.
  useBackendEvent("ui-command", (c) => {
    if (c.approvals) setDrawer(true);
    // Nothing to show on the connect screen; the project isn't open yet.
    if (!entered) return;
    if (c.item != null) {
      setSelected(c.item);
      setView("design");
    } else if (c.view && VIEWS.some((v) => v.id === c.view)) {
      setView(c.view as View);
    }
    if (c.tab && (INSPECTOR_TABS as readonly string[]).includes(c.tab)) setInspectorTab(c.tab as InspectorTab);
  });

  // Both resolve only once the card is decided; say how it ended wherever the user is now.
  const settle = useCallback(async (pending: Promise<Outcome>): Promise<Outcome | null> => {
    try {
      const o = await pending;
      if (o.status === "applied") toast.success(o.changes.length > 1 ? `Applied ${o.changes.length} changes` : `Applied: ${o.changes[0]}`);
      else if (o.status === "failed") toast.error(o.message);
      else toast.message(o.message);
      return o;
    } catch (e) {
      toast.error(errText(e));
      return null;
    }
  }, []);
  const propose = useCallback((ops: Op[], reason?: string) => settle(api.propose(ops, reason)), [settle]);
  const addDriver = useCallback((a: AddDriverArgs) => settle(api.addDriver(a)), [settle]);
  const openChat = useCallback((id: string) => { setChat(id); setView("agent"); }, []);

  const pending = approvals.filter((a) => a.status === "pending").length;

  const shell = useMemo<Shell | null>(() => {
    if (!status) return null;
    const director = status.config.directors.find((d) => d.id === status.config.active_director) ?? null;
    return {
      status, director,
      info: director ? info.get(director.id) ?? null : null,
      connected: !!director && status.connected.includes(director.id),
      writable: director?.mode === "approve",
      rev, approvals, propose, addDriver, refreshStatus,
      openApprovals: () => setDrawer(true),
      go: setView,
      selected, select: setSelected, inspectorTab, setInspectorTab, reportFocus: setFocus, chat, openChat,
    };
  }, [status, info, rev, approvals, propose, addDriver, refreshStatus, selected, inspectorTab, chat, openChat]);

  // Tell the backend what is on screen, so "this device" means something to an assistant.
  // Debounced: arrowing down the tree shouldn't be a call per row.
  const [dirId, dirName] = [shell?.director?.id, shell?.director?.name];
  const context = useMemo<UiContext>(() => {
    const design = entered && view === "design";
    return {
      view: entered ? view : "connect",
      director: dirId && dirName ? { id: dirId, name: dirName } : null,
      item: design ? focus : null,
      inspector_tab: design && focus ? inspectorTab : null,
    };
  }, [entered, view, dirId, dirName, focus, inspectorTab]);
  useEffect(() => {
    const t = setTimeout(() => void api.setUiContext(context).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [context]);

  if (!shell) {
    return <div className="boot">{error ? <Failure error={error} retry={refreshStatus} /> : <Loading what="Starting" />}</div>;
  }

  return (
    <Dialogs>
      <div className="app">
        <div className="tabs">
          <Logo />
          {/* No project is open on the connect screen, so there are no pages to switch to. */}
          {entered && VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? "on" : ""} onClick={() => setView(v.id)}>{v.label}</button>
          ))}
          <span className="grow" />
          {entered && <DirectorPicker status={shell.status} info={info} onManage={() => setView("settings")} onSwitch={() => setEntered(false)} />}
          <ApprovalsBell pending={pending} onClick={() => setDrawer(true)} />
        </div>

        <div className="work">
          {!entered ? (
            <ConnectScreen status={shell.status} info={info} onChanged={refreshStatus}
              onEnter={() => { setEntered(true); setView("design"); setRev((r) => r + 1); }} />
          ) : (
            <PageBoundary key={view}>
            <Suspense fallback={<Loading />}>
              {view === "design" ? <DesignPage shell={shell} />
                : view === "network" ? <NetworkPage shell={shell} />
                : view === "programming" ? <ProgrammingPage shell={shell} />
                : view === "agent" ? <AgentPage shell={shell} />
                : view === "backups" ? <BackupsPage shell={shell} />
                : view === "activity" ? <ActivityPage />
                : <SettingsPage shell={shell} />}
            </Suspense>
            </PageBoundary>
          )}
        </div>

        <StatusBar status={shell.status} info={shell.info} />
        <ApprovalsDrawer approvals={approvals} open={drawer} onOpenChange={setDrawer} />
        <McpAuthPrompt />
        <Toaster theme="system" richColors position="bottom-right" closeButton />
      </div>
    </Dialogs>
  );
}
