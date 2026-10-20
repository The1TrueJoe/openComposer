import { useEffect, useRef, useState } from "react";

export type MenuItem = {
  label?: string;
  icon?: React.ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** A separator: give it no label. */
  divider?: boolean;
};

/** A right-click menu, positioned where the click happened and kept on screen. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(x, window.innerWidth - r.width - 6), y: Math.min(y, window.innerHeight - r.height - 6) });
  }, [x, y]);

  useEffect(() => {
    // Close on a click *outside*: closing on any mousedown would unmount the item before its
    // own click lands, and every entry would silently do nothing.
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ctx" style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) => it.divider ? <div className="ctx-div" key={i} /> : (
        <button key={i} role="menuitem" disabled={it.disabled} className={it.danger ? "danger" : ""}
                onClick={() => { it.onSelect?.(); onClose(); }}>
          <span className="ctx-ic">{it.icon}</span>{it.label}
        </button>
      ))}
    </div>
  );
}

export function useContextMenu<T>() {
  const [open, setOpen] = useState<{ x: number; y: number; target: T } | null>(null);
  const show = (e: React.MouseEvent, target: T) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen({ x: e.clientX, y: e.clientY, target });
  };
  return { open, show, close: () => setOpen(null) };
}
