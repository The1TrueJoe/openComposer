import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useState } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { Tip } from "./Dialogs";

// Remembered widths are a convenience; a webview with storage blocked still lays out fine.
const storage = {
  getItem: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } },
};

/** A row of resizable panes whose widths are remembered per page. */
export function Panes({ id, children }: { id: string; children: React.ReactNode }) {
  const layout = useDefaultLayout({ id, storage });
  return <Group className="panes" orientation="horizontal" {...layout}>{children}</Group>;
}

export function Grip() {
  return <Separator className="grip" />;
}

/** The pane that takes what is left. */
export function MainPane({ id, minSize = 360, children }: { id: string; minSize?: number; children: React.ReactNode }) {
  return <Panel id={id} className="pane-cell" minSize={minSize}>{children}</Panel>;
}

/** A side pane that collapses to a labelled rail rather than to nothing: a pane that vanishes
 *  needs a button somewhere to bring it back, and the rail is that button. */
export function SidePane({ id, side, title, actions, defaultSize = 290, minSize = 200, maxSize = 520, children }: {
  id: string;
  side: "left" | "right";
  title: string;
  /** Controls for the head, beside the title. */
  actions?: React.ReactNode;
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  children: React.ReactNode;
}) {
  const ref = usePanelRef();
  const [shut, setShut] = useState(false);
  const Open = side === "left" ? PanelLeftOpen : PanelRightOpen;
  const Close = side === "left" ? PanelLeftClose : PanelRightClose;
  const hide = (
    <Tip text={`Hide ${title.toLowerCase()}`}>
      <button className="icon-btn" aria-label={`Hide ${title}`} onClick={() => ref.current?.collapse()}>
        <Close size={14} strokeWidth={1.8} />
      </button>
    </Tip>
  );
  return (
    <Panel id={id} className="pane-cell" collapsible collapsedSize={28} defaultSize={defaultSize} minSize={minSize} maxSize={maxSize}
           panelRef={ref} onResize={(s) => setShut(s.inPixels < 40)}>
      {shut ? (
        <button className="rail" title={`Show ${title.toLowerCase()}`} onClick={() => ref.current?.expand()}>
          <Open size={14} strokeWidth={1.8} /><span>{title}</span>
        </button>
      ) : (
        <div className={`panel side-${side}`}>
          <div className="panel-head">
            {side === "right" && hide}
            <span className="panel-title">{title}</span>
            <span className="grow" />
            {actions}
            {side === "left" && hide}
          </div>
          {children}
        </div>
      )}
    </Panel>
  );
}
