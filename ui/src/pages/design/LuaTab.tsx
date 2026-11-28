import { useEffect, useRef, useState } from "react";
import { api, errText, type LuaRecord } from "../../api";
import { Spinner } from "../../components/controls";
import { useBackendEvent } from "../../lib/ui";

/** A driver's live Lua output, like Composer's Lua tab: the driver's `print()` lines and Director's
 *  Lua errors ("attempt to call a nil value"). Fills from openComposer's recent buffer, then streams
 *  new lines on the `lua` event. The driver's Debug Mode must be On for it to emit anything. */
export function LuaTab({ device }: { device: number }) {
  const [lines, setLines] = useState<LuaRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setLines(null);
    setErr(null);
    api.driverLuaOutput(device).then((r) => setLines(r.lines), (e) => setErr(errText(e)));
  }, [device]);

  useBackendEvent("lua", (l) => {
    if (l.device !== device) return;
    setLines((cur) => {
      const next = [...(cur ?? []), l];
      return next.length > 2000 ? next.slice(next.length - 2000) : next;
    });
  });

  // Follow the tail unless the reader has scrolled up.
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="lua-tab">
      <div className="lua-head">
        <span className="dim small">Live Lua output — the driver's <b>Debug Mode</b> must be On</span>
        <span className="grow" />
        {!!lines?.length && <button className="act small quiet" onClick={() => setLines([])}>Clear</button>}
      </div>
      <div className="lua-log" ref={box}
           onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {err ? <p className="err pad">{err}</p>
          : lines === null ? <p className="dim pad"><Spinner /> Loading…</p>
          : !lines.length ? <p className="empty pad">No output yet. Turn on the driver's Debug Mode, then interact with the device — its <code>print()</code> lines appear here live.</p>
          : lines.map((l) => (
              <div key={l.seq} className="lua-line">
                <span className="lua-time">{fmtTime(l.at)}</span>
                <span className="lua-text">{l.text}</span>
              </div>
            ))}
      </div>
    </div>
  );
}

function fmtTime(unix: number): string {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleTimeString([], { hour12: false });
}
