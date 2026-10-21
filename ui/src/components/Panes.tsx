/** Resizable panes: side panes beside a main one (`orientation="horizontal"`, the default) and
 *  sections stacked above and below (`"vertical"`), all with remembered sizes, on
 *  react-resizable-panels v4. Plus `EdgeGrip`, for the odd thing that isn't in a pane group (the
 *  approvals sheet) but should still be dragged wider. It is layout only: what goes in a pane is
 *  the page's business. */

import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { Tip } from "./Dialogs";

// Remembered sizes are a convenience; a webview with storage blocked still lays out fine.
const storage = {
  getItem: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } },
};

/** A row (or column) of resizable panes whose sizes are remembered under `id`. Give `panelIds`
 *  when a pane comes and goes (a detail shown only while something is picked), so each set of
 *  panes keeps its own remembered layout. */
export function Panes({ id, orientation = "horizontal", panelIds, className, children }: {
  id: string;
  orientation?: "horizontal" | "vertical";
  panelIds?: string[];
  className?: string;
  children: React.ReactNode;
}) {
  const layout = useDefaultLayout({ id, storage, panelIds });
  return (
    <Group className={`panes ${orientation}${className ? ` ${className}` : ""}`} orientation={orientation} {...layout}>
      {children}
    </Group>
  );
}

/** The divider between two panes; its orientation follows the group's. */
export function Grip() {
  return <Separator className="grip" />;
}

/** The pane that takes what is left. In a vertical group, give it a smaller `minSize` (px). */
export function MainPane({ id, minSize = 360, children }: { id: string; minSize?: number | string; children: React.ReactNode }) {
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

/** A section below the main one in a vertical `Panes`: a detail, a list of other ends. Sizes are
 *  px (numbers) or percent of the group (strings). */
export function BottomPane({ id, defaultSize = 220, minSize = 80, maxSize = "85%", children }: {
  id: string;
  defaultSize?: number | string;
  minSize?: number | string;
  maxSize?: number | string;
  children: React.ReactNode;
}) {
  return <Panel id={id} className="pane-cell" defaultSize={defaultSize} minSize={minSize} maxSize={maxSize}>{children}</Panel>;
}

/** A list with an optional detail under it — the picked driver, the picked device — split by a
 *  grip and remembered under `id`. The list keeps its place in the tree whether or not the
 *  detail shows, so it keeps its scroll and focus when something is picked. */
export function WithDetail({ id, detail, defaultSize = 200, minSize = 90, children }: {
  id: string;
  detail: React.ReactNode;
  defaultSize?: number | string;
  minSize?: number | string;
  children: React.ReactNode;
}) {
  const shown = detail != null && detail !== false;
  return (
    <Panes id={id} orientation="vertical" panelIds={shown ? ["list", "detail"] : ["list"]} className="with-detail">
      <MainPane id="list" minSize={110}><div className="pane-stack">{children}</div></MainPane>
      {shown && <Grip />}
      {shown && <BottomPane id="detail" defaultSize={defaultSize} minSize={minSize} maxSize="75%">{detail}</BottomPane>}
    </Panes>
  );
}

/** A remembered size for something outside a pane group, in px, clamped. The third value says
 *  whether the user has ever set it, for boxes that size to their content until they do. */
export function useStoredSize(key: string, initial: number, min: number, max: number): [number, (px: number) => void, boolean] {
  const clamp = useCallback((n: number) => Math.round(Math.min(max, Math.max(min, n))), [min, max]);
  const [size, setSize] = useState<number | null>(() => {
    const saved = Number(storage.getItem(`oc-size:${key}`));
    return saved > 0 ? clamp(saved) : null;
  });
  const set = useCallback((px: number) => setSize(clamp(px)), [clamp]);
  useEffect(() => { if (size != null) storage.setItem(`oc-size:${key}`, String(size)); }, [key, size]);
  return [size ?? initial, set, size != null];
}

/** A grip on one edge of a box that isn't in a pane group: dragging it reports the box's new
 *  size. `edge` is the side the grip sits on ("left" for a sheet pinned to the right edge). */
export function EdgeGrip({ edge, size, onSize, label, min, max }: {
  edge: "left" | "right" | "top" | "bottom";
  size: number;
  onSize: (px: number) => void;
  label: string;
  min?: number;
  max?: number;
}) {
  const start = useRef<{ at: number; size: number } | null>(null);
  const [active, setActive] = useState(false);
  const across = edge === "left" || edge === "right";
  // Dragging toward the box's far side makes it smaller: a left-edge grip grows the box leftward.
  const sign = edge === "left" || edge === "top" ? -1 : 1;
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // Start from the size on screen: CSS may be holding the box smaller than the stored size.
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    start.current = { at: across ? e.clientX : e.clientY, size: box ? Math.round(across ? box.width : box.height) : size };
    setActive(true);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    onSize(start.current.size + sign * ((across ? e.clientX : e.clientY) - start.current.at));
  };
  const onUp = () => { start.current = null; setActive(false); };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 50 : 10;
    const grow = across ? (edge === "left" ? "ArrowLeft" : "ArrowRight") : (edge === "top" ? "ArrowUp" : "ArrowDown");
    const shrink = across ? (edge === "left" ? "ArrowRight" : "ArrowLeft") : (edge === "top" ? "ArrowDown" : "ArrowUp");
    if (e.key === grow) onSize(size + step);
    else if (e.key === shrink) onSize(size - step);
    else return;
    e.preventDefault();
  };
  return (
    <div className={`edge-grip ${edge}`} role="separator" aria-orientation={across ? "vertical" : "horizontal"} aria-label={label}
         aria-valuenow={size} aria-valuemin={min} aria-valuemax={max} tabIndex={0} data-separator={active ? "active" : undefined}
         onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey} />
  );
}
