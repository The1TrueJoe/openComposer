import { useEffect, useRef, useState } from "react";
import { isMock } from "../api";

/** Files dragged onto an element. In the app the webview reports drops with real paths (and
 *  the page never sees an HTML drop); the browser mock only gets file names, so it makes up
 *  paths the mock backend accepts. `accept` decides which drags light the target up. */
export function useDropFiles(onPaths: (paths: string[]) => void, accept: (path: string) => boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const handler = useRef(onPaths);
  handler.current = onPaths;
  const accepts = useRef(accept);
  accepts.current = accept;

  useEffect(() => {
    if (isMock) return;
    let off: (() => void) | undefined;
    let gone = false;
    let carrying = false;
    // Positions are physical pixels of the window; the element's rect is CSS pixels.
    const inside = (p: { x: number; y: number }) => {
      const r = ref.current?.getBoundingClientRect();
      const x = p.x / devicePixelRatio, y = p.y / devicePixelRatio;
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "leave") { carrying = false; setOver(false); return; }
      if (p.type === "enter") carrying = p.paths.some((x) => accepts.current(x));
      if (p.type === "drop") {
        setOver(false);
        if (inside(p.position)) handler.current(p.paths.filter((x) => accepts.current(x)));
        carrying = false;
        return;
      }
      setOver(carrying && inside(p.position));
    })).then((u) => { if (gone) u(); else off = u; });
    return () => { gone = true; off?.(); };
  }, []);

  const handlers = isMock ? {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      handler.current([...e.dataTransfer.files].map((f) => `/Users/you/Downloads/${f.name}`).filter((x) => accepts.current(x)));
    },
  } : {};
  return { ref, over, handlers };
}
