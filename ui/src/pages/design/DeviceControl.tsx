/** Composer's proxy control, modernised into the device's own remote: a light gets a power
 *  button, a brightness slider and (when it does colour) a colour wheel and a warm–cool slider;
 *  a TV, receiver or player gets a remote laid out like the one in the drawer; an HDMI matrix
 *  gets its input × output grid; anything else gets big buttons for what it can do. Every
 *  command its driver declares stays one tab away, with parameter inputs, and the live state and
 *  a log of what was sent sit beside the remote.
 *
 *  Commands from here are the user's own presses, so they are sent at once — no approval card —
 *  and each one is logged with Director's reply. Read-only Directors can be looked at, not
 *  controlled. Buttons appear only for commands the device declares (or, for a proxy that
 *  declares none, Control4's standard ones for its type — see `standardFor`). */

import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, Dot, FastForward, Gauge, Grid3x3, House, Info, LayoutList,
  Lightbulb, ListTree, LogIn, Menu, Minus, Palette, Pause, Play, Plus, Power, RefreshCw, Rewind, Search, Send, SkipBack, SkipForward, Square,
  Sun, SunDim, Thermometer, Tv, Undo2, Volume2, VolumeX, X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errText, type CommandDef, type CommandParam, type ConnectionDef, type ItemDetail, type ParamDef } from "../../api";
import { Tip } from "../../components/Dialogs";
import { Select, Spinner, Switch, Tabs } from "../../components/controls";
import { DriverIcon } from "../../components/icons";
import { ReadOnlyLock } from "../../components/shell";
import {
  cssRgb, familyOf, fillParams, findCommand, humanize, hsvToRgb, initialValue, isOn, kelvinToXy, lightStateOf, matrixPorts, normName,
  numberOf, paramProblem, paramType, parseVariables, rgbToXy, routeCommand, routesFrom, standardFor, stateOf, xyToRgb,
  type Available, type Family, type LiveVar, type Port, type Rgb,
} from "../../lib/control";
import type { Shell } from "../../lib/shell";
import { cx, time } from "../../lib/ui";

/** How often the state is read while the panel is open. */
const POLL_MS = 3000;
/** While a slider or the colour wheel is dragged, at most one command this often. */
const THROTTLE_MS = 300;
/** How long a value just sent is shown before the device's own report takes over again
 *  (devices report back a moment later; without this the control jumps back, then forward). */
const HOLD_MS = 2500;

interface Sent {
  n: number;
  at: string;
  target: string;
  command: string;
  params: CommandParam[];
  state: "sending" | "ok" | "error";
  reply: string;
  /** The same command sent again in quick succession (a held key, a dragged slider) is one row. */
  count: number;
}

type Send = (a: Available, params?: CommandParam[]) => Promise<void>;
type Layout = "light" | "remote" | "switch" | "generic";

/** Everything a remote needs to draw itself and send. */
interface Ctl {
  d: ItemDetail;
  items: ItemDetail[];
  available: Available[];
  vars: LiveVar[];
  send: Send;
  disabled: boolean;
  why?: string;
  /** The device's and its proxies' connections (each listed under the item that owns it). */
  connections: ConnectionDef[];
  /** `<capabilities>` of the device and its proxies, keys lower-cased. */
  caps: Record<string, string>;
}

export function DeviceControl({ id, shell, onClose }: { id: number | null; shell: Shell; onClose: () => void }) {
  return (
    <Dialog.Root open={id != null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg control" aria-describedby={undefined}>
          {id != null && <Panel key={id} id={id} shell={shell} onClose={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Capabilities as declared, read defensively: older backends don't send them at all. */
function capsOf(x: ItemDetail): Record<string, string> {
  const own = (x as { capabilities?: Record<string, string> | null }).capabilities;
  const all = { ...(x.device?.capabilities ?? {}), ...(own ?? {}) };
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

function Panel({ id, shell, onClose }: { id: number; shell: Shell; onClose: () => void }) {
  // The item and its proxies: commands and state live on both.
  const [items, setItems] = useState<ItemDetail[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [vars, setVars] = useState<LiveVar[]>([]);
  const [stateError, setStateError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<Sent[]>([]);
  const [tab, setTab] = useState<"remote" | "commands">("remote");
  const seq = useRef(0);
  const writable = shell.writable;
  const why = writable ? undefined : `${shell.director?.name ?? "This Director"} is read-only: commands are turned off.`;

  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const d = await api.item(id);
        const proxies = await Promise.all(d.children.filter((c) => c.kind === "proxy").map((c) => api.item(c.id)));
        if (!gone) setItems([d, ...proxies]);
      } catch (e) {
        if (!gone) setLoadError(errText(e));
      }
    })();
    return () => { gone = true; };
  }, [id]);

  const d = items?.[0];
  const ids = useMemo(() => items?.map((x) => x.id) ?? [], [items]);

  // Live state: every item's variables, re-read every few seconds while the panel is open.
  const prev = useRef(new Map<string, string>());
  const read = useCallback(async () => {
    if (!ids.length) return;
    setReading(true);
    try {
      const all = (await Promise.all(ids.map(async (x) => parseVariables((await api.deviceState(x)).variables, x)))).flat();
      const flips = new Set<string>();
      for (const v of all) {
        const k = `${v.owner}:${v.id}`;
        const was = prev.current.get(k);
        if (was != null && was !== v.value) flips.add(k);
        prev.current.set(k, v.value);
      }
      setVars(all);
      setStateError(null);
      if (flips.size) {
        setChanged(flips);
        setTimeout(() => setChanged(new Set()), 1400);
      }
    } catch (e) {
      setStateError(errText(e));
    } finally {
      setReading(false);
    }
  }, [ids]);
  useEffect(() => {
    if (!ids.length) return;
    void read();
    const t = setInterval(() => { if (!document.hidden) void read(); }, POLL_MS);
    return () => clearInterval(t);
  }, [ids, read]);

  const family: Family = useMemo(() => {
    if (!d) return "generic";
    return familyOf([...(d.device?.proxies ?? []), ...(items ?? []).slice(1).map((x) => x.driver), d.kind === "proxy" ? d.driver : null]);
  }, [d, items]);

  // Every command, by where it goes. A proxy that declares nothing gets its type's standard
  // commands, which Director understands for its built-in proxies.
  const available: Available[] = useMemo(() => (items ?? []).flatMap((x, i) => {
    const role = i === 0 && x.kind !== "proxy" ? "device" : (x.driver ?? "proxy").replace(/\.c4[iz]$/i, "");
    const own = (x.commands ?? []).map((def) => ({ target: x.id, targetName: x.name, role, def, standard: false }));
    if (own.length || (i === 0 && x.kind !== "proxy")) return own;
    return standardFor(x.driver).map((def) => ({ target: x.id, targetName: x.name, role, def, standard: true }));
  }), [items]);

  const connections = useMemo(() => (items ?? []).flatMap((x) => x.connections), [items]);
  const caps = useMemo(() => Object.assign({}, ...(items ?? []).map(capsOf)) as Record<string, string>, [items]);
  const route = useMemo(() => routeCommand(available), [available]);
  const layout = useMemo(() => layoutOf(family, available, connections, route), [family, available, connections, route]);

  // Devices report back a moment later: read soon after a command and once more after that.
  // A held key or a dragged slider sends often, so the reads are pushed back, not piled up.
  const later = useRef<number[]>([]);
  useEffect(() => () => later.current.forEach(clearTimeout), []);
  const send: Send = useCallback(async (a, params = []) => {
    const n = ++seq.current;
    const entry: Sent = { n, at: new Date().toISOString(), target: a.targetName, command: a.def.name, params, state: "sending", reply: "", count: 1 };
    setLog((l) => {
      const top = l[0];
      if (top && top.target === entry.target && top.command === entry.command && Date.now() - Date.parse(top.at) < 2000) {
        return [{ ...entry, count: top.count + 1 }, ...l.slice(1)];
      }
      return [entry, ...l].slice(0, 40);
    });
    const done = (patch: Partial<Sent>) => setLog((l) => l.map((x) => (x.n === n ? { ...x, ...patch } : x)));
    try {
      const r = await api.sendCommand(a.target, a.def.name, params);
      done({ state: "ok", reply: r.reply.join(" · ") });
    } catch (e) {
      done({ state: "error", reply: errText(e) });
    }
    later.current.forEach(clearTimeout);
    later.current = [window.setTimeout(() => void read(), 150), window.setTimeout(() => void read(), 1000)];
  }, [read]);

  if (!d || !items) {
    return (
      <>
        <Dialog.Title className="sr-only">Device control</Dialog.Title>
        {loadError ? <div className="control-body"><p className="err">{loadError}</p></div> : <div className="loading"><Spinner size="lg" /><span>Reading the device…</span></div>}
      </>
    );
  }

  const ctl: Ctl = { d, items, available, vars, send, disabled: !writable, why, connections, caps };
  const LAYOUT_TAB: Record<Layout, [string, React.ReactNode]> = {
    light: ["Light", <Lightbulb key="i" size={13} strokeWidth={1.8} />],
    remote: ["Remote", <Tv key="i" size={13} strokeWidth={1.8} />],
    switch: ["Matrix", <Grid3x3 key="i" size={13} strokeWidth={1.8} />],
    generic: [family === "thermostat" ? "Thermostat" : "Controls", family === "thermostat" ? <Thermometer key="i" size={13} strokeWidth={1.8} /> : <Gauge key="i" size={13} strokeWidth={1.8} />],
  };
  const sentLog = <SentLog log={log} clear={() => setLog([])} />;

  return (
    <>
      <div className="control-head">
        <span className="insp-ic"><DriverIcon driver={d.driver} kind={d.kind} proxy={d.device?.proxies[0]} size={26} /></span>
        <div className="control-title">
          <Dialog.Title className="dlg-title">{d.name}</Dialog.Title>
          <span className="dim small">{[d.room, d.device && `${d.device.manufacturer} ${d.device.model}`.trim(), d.driver].filter(Boolean).join(" · ")}</span>
        </div>
        <span className="grow" />
        <Tip text="Read the state now">
          <button className="icon-btn" aria-label="Refresh state" onClick={() => void read()}>
            <RefreshCw size={14} strokeWidth={1.8} className={reading ? "spinning" : ""} />
          </button>
        </Tip>
        <Dialog.Close asChild><button className="icon-btn" aria-label="Close"><X size={15} strokeWidth={1.8} /></button></Dialog.Close>
      </div>

      {!writable && (
        <div className="control-banner">
          <ReadOnlyLock name={shell.director?.name} />
          <span>{why} Switch it to “approve each write” in Settings › Directors to control devices from here.</span>
        </div>
      )}

      <Tabs className="detail-tabs control-tabs" value={tab} onChange={setTab} tabs={[
        { id: "remote", label: <>{LAYOUT_TAB[layout][1]}{LAYOUT_TAB[layout][0]}</> },
        { id: "commands", label: <><ListTree size={13} strokeWidth={1.8} />All commands<span className="rc-count">{available.length}</span></> },
      ]} />

      <div className="control-body">
        {tab === "remote" ? (
          <div className={cx("rc-stage", layout === "switch" && "wide")}>
            <div className="rc-main">
              {layout === "light" && <LightRemote ctl={ctl} />}
              {layout === "remote" && <Remote ctl={ctl} family={family} />}
              {layout === "switch" && route && <Matrix ctl={ctl} route={route} />}
              {layout === "generic" && (
                <section className="control-card rc-panel">
                  <div className="control-card-head"><Gauge size={13} strokeWidth={1.8} />Controls</div>
                  <Quick family={family} available={available} vars={vars} send={send} disabled={!writable} why={why} d={d} />
                </section>
              )}
              {(layout === "generic" || layout === "switch") && <Extras ctl={ctl} layout={layout} />}
            </div>
            <aside className="rc-side">
              {(layout === "remote" || layout === "light") && <Extras ctl={ctl} layout={layout} />}
              <section className="control-card">
                <div className="control-card-head">
                  <span>Live state</span>
                  <span className="spread dim small">{stateError ? "" : `every ${POLL_MS / 1000}s`}</span>
                </div>
                {stateError && <p className="err small flush-p">{stateError}</p>}
                {!stateError && !vars.length && <p className="dim small flush-p">{reading ? "Reading…" : "This device reports no variables."}</p>}
                {!!vars.length && (
                  <div className="state-grid">
                    {vars.map((v) => (
                      <div key={`${v.owner}:${v.id}`} className={cx("state-row", changed.has(`${v.owner}:${v.id}`) && "flash")}>
                        <span className="mono k" title={v.owner !== d.id ? (items.find((x) => x.id === v.owner)?.name ?? "") : undefined}>{v.name}</span>
                        <span className="mono v">{v.value === "" ? <i className="dim">empty</i> : v.value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              {sentLog}
              {available.some((a) => a.standard) && (
                <p className="dim small flush-p rc-note">Some buttons use Control4's standard commands for this proxy type; the proxy didn't list its own.</p>
              )}
            </aside>
          </div>
        ) : (
          <>
            {sentLog}
            <Commands available={available} name={d.name} send={send} disabled={!writable} why={why} />
          </>
        )}
      </div>
      <div className="control-foot">
        <span className="dim small">Commands go straight to the device — they change no project data, so there's no approval card.</span>
        <button className="act" onClick={onClose}>Done</button>
      </div>
    </>
  );
}

function SentLog({ log, clear }: { log: Sent[]; clear: () => void }) {
  if (!log.length) return null;
  return (
    <section className="control-log" aria-label="Sent commands">
      <div className="control-card-head"><Send size={13} strokeWidth={1.8} />Sent
        <button className="act small quiet spread" onClick={clear}>Clear</button>
      </div>
      {log.map((s) => (
        <div key={s.n} className={cx("log-row", s.state)}>
          <span className="dim mono small">{time(s.at)}</span>
          <span className="log-icon">{s.state === "sending" ? <Spinner /> : s.state === "ok" ? <Check size={13} strokeWidth={2} /> : <AlertTriangle size={13} strokeWidth={1.8} />}</span>
          <span className="mono log-cmd">{s.command}{s.params.length ? `(${s.params.map((p) => `${p.name}=${p.value}`).join(", ")})` : ""}{s.count > 1 && <span className="dim"> ×{s.count}</span>}</span>
          <span className="dim small">→ {s.target}</span>
          <span className={cx("log-reply small", s.state === "error" ? "err" : "dim")}>{s.state === "ok" ? (s.reply || "sent") : s.reply}</span>
        </div>
      ))}
    </section>
  );
}

// ---- which remote ------------------------------------------------------------------------------

/** The names each remote looks for, in order of preference (drivers spell them differently). */
const K = {
  on: ["ON", "POWER_ON"], off: ["OFF", "POWER_OFF"], toggle: ["POWER_TOGGLE", "POWER", "TOGGLE"],
  home: ["HOME"], inputCycle: ["PULSE_INPUT", "INPUT_CYCLE", "INPUT", "SOURCE"], input: ["SET_INPUT"],
  up: ["UP", "CURSOR_UP", "NAV_UP", "ARROW_UP"], down: ["DOWN", "CURSOR_DOWN", "NAV_DOWN", "ARROW_DOWN"],
  left: ["LEFT", "CURSOR_LEFT", "NAV_LEFT", "ARROW_LEFT"], right: ["RIGHT", "CURSOR_RIGHT", "NAV_RIGHT", "ARROW_RIGHT"],
  ok: ["ENTER", "SELECT", "OK"], back: ["CANCEL", "BACK", "EXIT", "RETURN"], menu: ["MENU"], info: ["INFO", "DISPLAY"], guide: ["GUIDE"],
  volUp: ["PULSE_VOL_UP", "VOLUME_UP", "VOL_UP"], volDown: ["PULSE_VOL_DOWN", "VOLUME_DOWN", "VOL_DOWN"],
  volUpStart: ["START_VOL_UP"], volUpStop: ["STOP_VOL_UP"], volDownStart: ["START_VOL_DOWN"], volDownStop: ["STOP_VOL_DOWN"],
  chUp: ["PULSE_CH_UP", "CHANNEL_UP", "CH_UP"], chDown: ["PULSE_CH_DOWN", "CHANNEL_DOWN", "CH_DOWN"],
  chUpStart: ["START_CH_UP"], chUpStop: ["STOP_CH_UP"], chDownStart: ["START_CH_DOWN"], chDownStop: ["STOP_CH_DOWN"],
  mute: ["MUTE_TOGGLE", "MUTE"], muteOn: ["MUTE_ON"], muteOff: ["MUTE_OFF"],
  recall: ["RECALL", "PREV", "PREVIOUS_CHANNEL", "LAST", "LAST_CHANNEL"], volume: ["SET_VOLUME_LEVEL"],
  skipRev: ["SKIP_REV", "PREVIOUS", "PREV_TRACK"], scanRev: ["SCAN_REV", "REWIND", "REW"], play: ["PLAY"], playPause: ["PLAY_PAUSE"],
  pause: ["PAUSE"], stop: ["STOP"], scanFwd: ["SCAN_FWD", "FAST_FORWARD", "FF"], skipFwd: ["SKIP_FWD", "NEXT", "NEXT_TRACK"], record: ["RECORD", "REC"],
  red: ["PROGRAM_A", "RED"], green: ["PROGRAM_B", "GREEN"], yellow: ["PROGRAM_C", "YELLOW"], blue: ["PROGRAM_D", "BLUE"],
  pageUp: ["PAGE_UP"], pageDown: ["PAGE_DOWN"], dvr: ["DVR"], live: ["LIVE_TV", "LIVE"], tvVideo: ["TV_VIDEO"], cc: ["CLOSED_CAPTION", "CC", "SUBTITLE"],
  settings: ["SETTINGS", "SETUP"], list: ["LIST"], favorites: ["FAVORITES", "FAVORITE"], eject: ["EJECT"],
  star: ["STAR", "ASTERISK"], dash: ["DASH", "HYPHEN", "PERIOD", "DOT"], pound: ["POUND", "HASH"],
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}`, [`NUMBER_${i}`, `DIGIT_${i}`, `NUM_${i}`, String(i)]])),
} as Record<string, string[]>;

const REMOTE_PLACED = new Set(Object.values(K).flat());
const LIGHT_PLACED = new Set(["ON", "OFF", "TOGGLE", "SET_LEVEL", "RAMP_TO_LEVEL", "SET_BRIGHTNESS_TARGET", "SET_COLOR_TARGET", "SET_COLOR",
  "SET_COLOR_TEMPERATURE", "SET_CCT", "SET_KELVIN"]);
const QUICK_PLACED = new Set(["ON", "OFF", "SET_LEVEL", "RAMP_TO_LEVEL", "SET_VOLUME_LEVEL", "PULSE_VOL_UP", "PULSE_VOL_DOWN", "MUTE_TOGGLE",
  "MUTE_ON", "MUTE_OFF", "SET_INPUT", "PLAY", "PAUSE", "STOP", "SKIP_REV", "SKIP_FWD", "SET_SETPOINT_HEAT", "SET_SETPOINT_COOL", "SET_MODE_HVAC"]);

function layoutOf(family: Family, available: Available[], connections: ConnectionDef[], route: ReturnType<typeof routeCommand>): Layout {
  if (family === "light") return "light";
  if (family === "switch" && route) return "switch";
  // Anything else with several video inputs and outputs and a command that routes between them
  // is a matrix too, whatever proxy its driver chose.
  if (family === "generic" && route?.output) {
    const ins = matrixPorts(route.input, connections, "input"), outs = matrixPorts(route.output, connections, "output");
    if (ins.length >= 2 && outs.length >= 2) return "switch";
  }
  if (family === "tv" || family === "media" || family === "av") return "remote";
  const keys = ["up", "down", "left", "right", "ok", "volUp", "chUp", "n1", "play", "menu"].filter((k) => findCommand(available, ...K[k]));
  return keys.length >= 4 ? "remote" : "generic";
}

// ---- remote keys ------------------------------------------------------------------------------

/** Calls `fn` at most every `ms` while values keep coming (first one at once, the latest one
 *  when the wait is up), and `flush` sends the final value straight away. */
function useThrottle<T>(fn: (v: T) => void, ms = THROTTLE_MS) {
  const fnRef = useRef(fn);
  useLayoutEffect(() => { fnRef.current = fn; });
  const st = useRef<{ last: number; timer?: number; pending?: { v: T }; sent?: string }>({ last: 0 });
  useEffect(() => () => clearTimeout(st.current.timer), []);
  return useMemo(() => {
    const fire = (v: T) => {
      const s = st.current;
      s.last = Date.now();
      s.pending = undefined;
      const k = JSON.stringify(v);
      if (k === s.sent) return;
      s.sent = k;
      fnRef.current(v);
    };
    return {
      push(v: T) {
        const s = st.current;
        s.pending = { v };
        if (s.timer != null) return;
        const wait = ms - (Date.now() - s.last);
        if (wait <= 0) fire(v);
        else s.timer = window.setTimeout(() => { s.timer = undefined; if (s.pending) fire(s.pending.v); }, wait);
      },
      /** The end of a gesture: send the last value unless it just went, then forget it, so the
       *  same value can be sent again next time. */
      flush(v: T) {
        const s = st.current;
        clearTimeout(s.timer);
        s.timer = undefined;
        fire(v);
        s.sent = undefined;
      },
    };
  }, [ms]);
}

/** A value the user just set, shown in place of the device's report until the report catches up. */
function useHeld<T>(live: T): [T, (v: T) => void] {
  const [held, setHeld] = useState<{ v: T } | null>(null);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  const hold = useCallback((v: T) => {
    setHeld({ v });
    clearTimeout(t.current);
    t.current = window.setTimeout(() => setHeld(null), HOLD_MS);
  }, []);
  return [held ? held.v : live, hold];
}

/** How long a press must last to count as held. */
const HOLD_AFTER_MS = 350;

/** One button on a remote. It sends when pressed, like a real one. With `hold` (START_/STOP_
 *  commands), a tap sends the pulse command and a long press starts, then stops on release;
 *  with `repeat`, a long press repeats the command, as volume keys do. Renders nothing when
 *  the device has no such command. */
function Key({ ctl, a, label, className, on, repeat, hold, params, caption, children }: {
  ctl: Ctl; a: Available | undefined; label: string; className?: string; on?: boolean; repeat?: boolean;
  hold?: { start: Available | undefined; stop: Available | undefined }; params?: CommandParam[]; caption?: string; children: React.ReactNode;
}) {
  const [down, setDown] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const phase = useRef<"idle" | "pressed" | "holding">("idle");
  useEffect(() => () => clearTimeout(timer.current), []);
  const canHold = !!(hold?.start && hold.stop);
  if (!a && !canHold) return null;

  const fire = () => { if (a) void ctl.send(a, params); };
  const press = () => {
    if (ctl.disabled || phase.current !== "idle") return;
    phase.current = "pressed";
    setDown(true);
    if (canHold) {
      timer.current = window.setTimeout(() => { phase.current = "holding"; void ctl.send(hold!.start!); }, HOLD_AFTER_MS);
      return;
    }
    fire();
    if (repeat) {
      const again = () => { fire(); timer.current = window.setTimeout(again, 260); };
      timer.current = window.setTimeout(again, 450);
    }
  };
  const release = () => {
    if (phase.current === "idle") return;
    clearTimeout(timer.current);
    if (canHold) {
      if (phase.current === "holding") void ctl.send(hold!.stop!);
      else if (a) fire();
      else void ctl.send(hold!.start!).then(() => ctl.send(hold!.stop!));
    }
    phase.current = "idle";
    setDown(false);
  };
  const names = [a?.def.name, canHold ? `${hold!.start!.def.name} (hold)` : null].filter(Boolean).join(" · ");
  return (
    <button type="button" className={cx("rc-key", className, on && "on", down && "pressed")} aria-label={label} aria-pressed={on}
            title={ctl.why ?? `${label} — ${names}${a?.standard ? " (standard command)" : ""}`} disabled={ctl.disabled} data-caption={caption}
            onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); press(); }}
            onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
            onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); press(); } }}
            onKeyUp={(e) => { if (e.key === "Enter" || e.key === " ") release(); }}
            onBlur={release} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </button>
  );
}

/** Power: separate On and Off when the device has both (the lit one is its state), else one key. */
function PowerKeys({ ctl, powered }: { ctl: Ctl; powered: boolean | null }) {
  const f = (k: string) => findCommand(ctl.available, ...K[k]);
  const on = f("on"), off = f("off"), toggle = f("toggle");
  if (on && off) {
    return (
      <div className="rc-power" role="group" aria-label="Power">
        <Key ctl={ctl} a={on} label="Power on" className="rc-pill power" on={powered === true}><Power size={14} strokeWidth={2.2} />On</Key>
        <Key ctl={ctl} a={off} label="Power off" className="rc-pill power" on={powered === false}>Off</Key>
      </div>
    );
  }
  const one = toggle ?? (powered ? off ?? on : on ?? off);
  return <Key ctl={ctl} a={one} label="Power" className="rc-round power" on={powered === true}><Power size={18} strokeWidth={2.2} /></Key>;
}

/** The device's inputs as buttons: the command's own options, else its input connections. */
function InputKeys({ ctl }: { ctl: Ctl }) {
  const a = findCommand(ctl.available, ...K.input);
  const def = a?.def.params.find((x) => /INPUT|SOURCE/i.test(x.name)) ?? a?.def.params[0];
  const [picked, hold] = useHeld<string | null>(null);
  const options: Port[] = useMemo(() => {
    if (!a) return [];
    if (def?.items.length) return def.items.map((o) => ({ key: o, label: o, detail: "", value: o }));
    return matrixPorts(undefined, ctl.connections, "input");
  }, [a, def, ctl.connections]);
  if (!a || !options.length) return null;
  const now = stateOf(ctl.vars, "CURRENT_INPUT", "INPUT", "CURRENT_SELECTED_INPUT", "CURRENT_SOURCE", "SOURCE");
  const current = picked ?? options.find((o) => o.value === now || o.label.toLowerCase() === now?.toLowerCase())?.key ?? null;
  const go = (o: Port) => {
    hold(o.key);
    void ctl.send(a, fillParams(a.def, [[/INPUT|SOURCE/i, () => o.value]], [{ name: "INPUT", type: "INTEGER", value: o.value }]));
  };
  return (
    <div className="rc-block">
      <div className="rc-cap"><LogIn size={12} strokeWidth={2} />Input{now && !options.some((o) => o.key === current) && <span className="dim"> · now {now}</span>}</div>
      {options.length > 12 ? (
        <Select value={current ?? ""} disabled={ctl.disabled} label="Input" placeholder={now ?? "Choose…"}
                options={options.map((o) => ({ value: o.key, label: o.label }))}
                onValueChange={(k) => { const o = options.find((x) => x.key === k); if (o) go(o); }} />
      ) : (
        <div className="rc-chips">
          {options.map((o) => (
            <button key={o.key} type="button" className={cx("rc-chip", current === o.key && "on")} disabled={ctl.disabled} aria-pressed={current === o.key}
                    title={ctl.why ?? `${a.def.name} ${o.value}${o.detail ? ` — ${o.detail}` : ""}`} onClick={() => go(o)}>
              <span>{o.label}</span>{o.detail && <small>{o.detail}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- TV / receiver / player remote ------------------------------------------------------------

const LETTERS = ["", "", "ABC", "DEF", "GHI", "JKL", "MNO", "PQRS", "TUV", "WXYZ"];

function Remote({ ctl, family }: { ctl: Ctl; family: Family }) {
  const f = (k: string) => findCommand(ctl.available, ...K[k]);
  const vars = ctl.vars;
  const powerState = stateOf(vars, "POWER_STATE", "POWER");
  const powered = powerState == null ? null : isOn(powerState);
  const muted = isOn(stateOf(vars, "MUTE_STATE", "MUTE"));
  const volLevel = numberOf(stateOf(vars, "VOLUME_LEVEL", "VOLUME", "CURRENT_VOLUME"));
  const channel = stateOf(vars, "CURRENT_CHANNEL", "CHANNEL");
  const playState = stateOf(vars, "PLAY_STATE", "TRANSPORT_STATE");
  const has = (...ks: string[]) => ks.some((k) => f(k));
  const icon = (n: React.ComponentType<{ size?: number; strokeWidth?: number }>, size = 17) => { const I = n; return <I size={size} strokeWidth={2} />; };

  const mute = f("mute") ?? (muted ? f("muteOff") ?? f("muteOn") : f("muteOn") ?? f("muteOff"));
  const volume = f("volume");

  const top = (
    <div className="rc-row rc-top" key="top">
      <PowerKeys ctl={ctl} powered={powered} />
      <span className="grow" />
      <Key ctl={ctl} a={f("inputCycle")} label="Input" className="rc-pill"><LogIn size={14} strokeWidth={2} />Input</Key>
      <Key ctl={ctl} a={f("home")} label="Home" className="rc-round">{icon(House)}</Key>
    </div>
  );

  const nav = has("up", "down", "left", "right", "ok") && (
    <div className="rc-nav" key="nav">
      <Key ctl={ctl} a={f("back")} label="Back" className="rc-round rc-corner tl" caption="Back">{icon(Undo2, 16)}</Key>
      <Key ctl={ctl} a={f("menu")} label="Menu" className="rc-round rc-corner tr" caption="Menu">{icon(Menu, 16)}</Key>
      <Key ctl={ctl} a={f("info")} label="Info" className="rc-round rc-corner bl" caption="Info">{icon(Info, 16)}</Key>
      <Key ctl={ctl} a={f("guide")} label="Guide" className="rc-round rc-corner br" caption="Guide">{icon(LayoutList, 16)}</Key>
      <div className="rc-dpad">
        <Key ctl={ctl} a={f("up")} label="Up" className="rc-dir up" repeat>{icon(ChevronUp, 22)}</Key>
        <Key ctl={ctl} a={f("right")} label="Right" className="rc-dir right" repeat>{icon(ChevronRight, 22)}</Key>
        <Key ctl={ctl} a={f("down")} label="Down" className="rc-dir down" repeat>{icon(ChevronDown, 22)}</Key>
        <Key ctl={ctl} a={f("left")} label="Left" className="rc-dir left" repeat>{icon(ChevronLeft, 22)}</Key>
        <Key ctl={ctl} a={f("ok")} label="OK" className="rc-ok">OK</Key>
      </div>
    </div>
  );
  // Without a d-pad, the menu keys still belong somewhere.
  const menuRow = !nav && has("back", "menu", "info", "guide") && (
    <div className="rc-row rc-center" key="menus">
      <Key ctl={ctl} a={f("back")} label="Back" className="rc-pill">{icon(Undo2, 14)}Back</Key>
      <Key ctl={ctl} a={f("menu")} label="Menu" className="rc-pill">{icon(Menu, 14)}Menu</Key>
      <Key ctl={ctl} a={f("info")} label="Info" className="rc-pill">{icon(Info, 14)}Info</Key>
      <Key ctl={ctl} a={f("guide")} label="Guide" className="rc-pill">{icon(LayoutList, 14)}Guide</Key>
    </div>
  );

  const volRocker = has("volUp", "volDown", "volUpStart", "volDownStart");
  const chRocker = has("chUp", "chDown", "chUpStart", "chDownStart");
  const rockers = (volRocker || chRocker || mute) && (
    <div className="rc-rockers" key="rockers">
      {volRocker ? (
        <div className="rc-rocker" role="group" aria-label="Volume">
          <Key ctl={ctl} a={f("volUp")} hold={{ start: f("volUpStart"), stop: f("volUpStop") }} repeat label="Volume up" className="rc-rock up">{icon(Plus)}</Key>
          <span className="rc-rock-label">VOL{volLevel != null && <b>{volLevel}</b>}</span>
          <Key ctl={ctl} a={f("volDown")} hold={{ start: f("volDownStart"), stop: f("volDownStop") }} repeat label="Volume down" className="rc-rock down">{icon(Minus)}</Key>
        </div>
      ) : <span className="rc-rocker-gap" />}
      <div className="rc-mid">
        <Key ctl={ctl} a={mute} label={muted ? "Unmute" : "Mute"} className="rc-round" on={muted} caption="Mute">
          {muted ? icon(VolumeX) : icon(Volume2)}
        </Key>
        <Key ctl={ctl} a={f("recall")} label="Last channel" className="rc-round" caption="Last">{icon(Undo2, 15)}</Key>
      </div>
      {chRocker ? (
        <div className="rc-rocker" role="group" aria-label="Channel">
          <Key ctl={ctl} a={f("chUp")} hold={{ start: f("chUpStart"), stop: f("chUpStop") }} label="Channel up" className="rc-rock up">{icon(ChevronUp, 19)}</Key>
          <span className="rc-rock-label">CH{channel && <b>{channel}</b>}</span>
          <Key ctl={ctl} a={f("chDown")} hold={{ start: f("chDownStart"), stop: f("chDownStop") }} label="Channel down" className="rc-rock down">{icon(ChevronDown, 19)}</Key>
        </div>
      ) : <span className="rc-rocker-gap" />}
    </div>
  );

  const volSlider = volume && (
    <div className="rc-block" key="volume">
      <div className="rc-cap"><Volume2 size={12} strokeWidth={2} />Volume</div>
      <LevelSlider ctl={ctl} a={volume} value={volLevel} label="Volume" />
    </div>
  );

  const transportKeys: [string, React.ReactNode, string][] = [
    ["skipRev", icon(SkipBack, 16), "Previous"], ["scanRev", icon(Rewind, 16), "Rewind"], ["play", icon(Play, 18), "Play"],
    ["playPause", <span key="pp" className="rc-pp">{icon(Play, 13)}{icon(Pause, 13)}</span>, "Play/pause"], ["pause", icon(Pause, 18), "Pause"],
    ["stop", icon(Square, 14), "Stop"], ["scanFwd", icon(FastForward, 16), "Fast forward"], ["skipFwd", icon(SkipForward, 16), "Next"],
    ["record", <Circle key="rec" size={14} strokeWidth={0} fill="currentColor" />, "Record"],
  ];
  const playing = playState ? playState.toLowerCase() : "";
  const transport = transportKeys.some(([k]) => f(k)) && (
    <div className="rc-block" key="transport">
      {playState && <div className="rc-cap">{playState}</div>}
      <div className="rc-transport">
        {transportKeys.map(([k, ic, label]) => (
          <Key key={k} ctl={ctl} a={f(k)} label={label} className={cx("rc-round", k === "play" && "big", k === "record" && "rec")}
               on={(k === "play" && /play/.test(playing)) || (k === "pause" && /pause/.test(playing)) || (k === "stop" && /stop/.test(playing))}>
            {ic}
          </Key>
        ))}
      </div>
    </div>
  );

  const fnKeys: [string, React.ReactNode][] = [
    ["pageUp", <>{icon(ChevronUp, 13)}Page</>], ["pageDown", <>{icon(ChevronDown, 13)}Page</>], ["dvr", "DVR"], ["live", "Live"], ["list", "List"],
    ["favorites", "Fav"], ["tvVideo", "TV/Video"], ["cc", "CC"], ["settings", "Settings"], ["eject", "Eject"],
  ];
  const fns = fnKeys.some(([k]) => f(k)) && (
    <div className="rc-row rc-center rc-wrap" key="fns">
      {fnKeys.map(([k, body]) => <Key key={k} ctl={ctl} a={f(k)} label={humanize(k.replace(/([A-Z])/g, "_$1"))} className="rc-pill small">{body}</Key>)}
    </div>
  );

  const colors = has("red", "green", "yellow", "blue") && (
    <div className="rc-colors" key="colors">
      {(["red", "green", "yellow", "blue"] as const).map((k) => <Key key={k} ctl={ctl} a={f(k)} label={`${humanize(k)} button`} className={cx("rc-color", k)}>{""}</Key>)}
    </div>
  );

  const digits = Array.from({ length: 10 }, (_, i) => f(`n${i}`));
  const okUsesEnter = f("ok") && normName(f("ok")!.def.name) === "ENTER";
  const left = f("dash") ?? f("star");
  const right = f("pound") ?? (okUsesEnter ? undefined : findCommand(ctl.available, "ENTER"));
  const numpad = digits.some(Boolean) && (
    <div className="rc-numpad" key="numpad">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
        <Key key={n} ctl={ctl} a={digits[n]} label={String(n)} className="rc-num"><b>{n}</b><small>{LETTERS[n]}</small></Key>
      ))}
      {left ? <Key ctl={ctl} a={left} label={humanize(left.def.name)} className="rc-num"><b>{/STAR|ASTERISK/.test(normName(left.def.name)) ? "✱" : "–"}</b></Key> : <span />}
      <Key ctl={ctl} a={digits[0]} label="0" className="rc-num"><b>0</b></Key>
      {right ? <Key ctl={ctl} a={right} label={humanize(right.def.name)} className="rc-num"><b>{/POUND|HASH/.test(normName(right.def.name)) ? "#" : "↵"}</b></Key> : <span />}
    </div>
  );

  // A receiver is mostly volume and inputs; a player mostly navigation and playback (a cable
  // box is a player with channels, so it's laid out like a TV).
  const sections = family === "av"
    ? [top, <InputKeys key="inputs" ctl={ctl} />, rockers, volSlider, nav, menuRow, transport, fns, colors, numpad]
    : family === "media" && !chRocker
      ? [top, <InputKeys key="inputs" ctl={ctl} />, nav, menuRow, transport, rockers, volSlider, fns, colors, numpad]
      : [top, <InputKeys key="inputs" ctl={ctl} />, nav, menuRow, rockers, volSlider, transport, fns, colors, numpad];

  return (
    <div className="rc-body" aria-label={`${ctl.d.name} remote`}>
      {sections.filter(Boolean)}
      <div className="rc-brand">{ctl.d.device?.manufacturer || ctl.d.name}</div>
    </div>
  );
}

/** A big slider for a 0–100 (or declared range) level: sends while dragged (throttled) and
 *  again when let go. */
function LevelSlider({ ctl, a, value, label, unit = "", fill, icons }: {
  ctl: Ctl; a: Available; value: number | null; label: string; unit?: string; fill?: string; icons?: [React.ReactNode, React.ReactNode];
}) {
  const def = a.def.params.find((x) => /LEVEL|BRIGHTNESS|VALUE|VOLUME|TARGET$/i.test(x.name) && !/RATE|TIME/i.test(x.name)) ?? a.def.params[0];
  const lo = Number(def?.minimum ?? 0), hi = Number(def?.maximum ?? 100);
  const [drag, setDrag] = useState<number | null>(null);
  const [shownLive, hold] = useHeld(value);
  const out = useThrottle((n: number) => {
    void ctl.send(a, fillParams(a.def, [
      [/RATE|TIME|DURATION/i, (p) => initialValue(p) || "0"],
      [new RegExp(`^${def?.name ?? "LEVEL"}$`), () => String(n)],
    ], [{ name: "LEVEL", type: "INTEGER", value: String(n) }]));
  });
  const shown = drag ?? shownLive ?? lo;
  const end = (n: number) => { setDrag(null); hold(n); out.flush(n); };
  const pct = hi > lo ? ((shown - lo) / (hi - lo)) * 100 : 0;
  return (
    <div className="rc-level">
      {icons?.[0]}
      <input type="range" className="rc-slider" min={lo} max={hi} value={shown} disabled={ctl.disabled} aria-label={label}
             title={ctl.why ?? `${a.def.name}${a.standard ? " (standard command)" : ""}`}
             style={{ "--p": pct / 100, ...(fill ? { "--rc-fill": fill } : {}) } as React.CSSProperties}
             onChange={(e) => { const n = Number(e.target.value); setDrag(n); out.push(n); }}
             onPointerUp={(e) => end(Number((e.target as HTMLInputElement).value))}
             onKeyUp={(e) => { if (/Arrow|Page|Home|End/.test(e.key)) end(Number((e.target as HTMLInputElement).value)); }} />
      {icons?.[1]}
      <span className="mono rc-level-num">{value == null && drag == null && shownLive == null ? "—" : `${Math.round(shown)}${unit}`}</span>
    </div>
  );
}

// ---- lights ------------------------------------------------------------------------------------

const truthy = (v: string | undefined) => v != null && /^(true|1|yes)$/i.test(v.trim());

/** light_v2's colour command, for a light whose proxy declares none: what the proxy takes. */
const COLOR_TARGET: CommandDef = {
  name: "SET_COLOR_TARGET", description: "Set NAME colour",
  params: ["LIGHT_COLOR_TARGET_X", "LIGHT_COLOR_TARGET_Y"].map((name): ParamDef => ({ name, prop_type: "FLOAT", default: null, readonly: false, items: [], minimum: "0", maximum: "1" }))
    .concat(["LIGHT_COLOR_TARGET_MODE", "LIGHT_COLOR_TARGET_RATE"].map((name) => ({ name, prop_type: "INTEGER", default: "0", readonly: false, items: [], minimum: null, maximum: null }))),
};

const SWATCHES: { label: string; h?: number; s?: number; k?: number }[] = [
  { label: "Warm white", k: 2700 }, { label: "Neutral white", k: 4000 }, { label: "Daylight", k: 6500 },
  { label: "Red", h: 0, s: 1 }, { label: "Orange", h: 28, s: 1 }, { label: "Yellow", h: 52, s: 1 }, { label: "Green", h: 125, s: 1 },
  { label: "Cyan", h: 185, s: 1 }, { label: "Blue", h: 228, s: 1 }, { label: "Purple", h: 275, s: 1 }, { label: "Pink", h: 320, s: 0.6 },
];

function LightRemote({ ctl }: { ctl: Ctl }) {
  const f = (...n: string[]) => findCommand(ctl.available, ...n);
  const st = lightStateOf(ctl.vars);
  const caps = ctl.caps;
  const on = f("ON"), off = f("OFF"), toggle = f("TOGGLE");
  const level = f("SET_LEVEL", "RAMP_TO_LEVEL", "SET_BRIGHTNESS_TARGET");
  const declaredColor = f("SET_COLOR_TARGET", "SET_COLOR");
  const cctCmd = f("SET_COLOR_TEMPERATURE", "SET_CCT", "SET_KELVIN");

  // Colour: what the driver declares in <capabilities>, else what it shows it can do.
  const color = caps.supports_color != null ? truthy(caps.supports_color) : !!declaredColor || st.hs != null;
  const cct = caps.supports_color_correlated_temperature != null
    ? truthy(caps.supports_color_correlated_temperature)
    : st.kelvin != null || !!cctCmd || color;
  const kMin = numberOf(caps.color_correlated_temperature_min ?? null) ?? 2000;
  const kMax = numberOf(caps.color_correlated_temperature_max ?? null) ?? 6500;
  const light = ctl.items.find((x) => /^light/i.test(x.driver ?? "")) ?? ctl.d;
  const colorCmd: Available | undefined = declaredColor ?? ((color || cct) ? {
    target: light.id, targetName: light.name, role: (light.driver ?? "light_v2").replace(/\.c4[iz]$/i, ""), def: COLOR_TARGET, standard: true,
  } : undefined);

  const [hs, holdHs] = useHeld(st.hs);
  const [kelvin, holdK] = useHeld(st.kelvin);
  const [mode, holdMode] = useHeld(st.mode);
  const [powerHeld, holdPower] = useHeld(st.on);

  const sendXy = (xy: [number, number], cctMode: boolean, extra: { h?: number; s?: number; k?: number }) => {
    if (!colorCmd) return;
    const [r, g, b] = xyToRgb(xy[0], xy[1]);
    const modeValue = (p: ParamDef) => p.items.length
      ? p.items.find((i) => (cctMode ? /cct|temp|kelvin|^1$/i : /xy|colou?r|^0$/i).test(i)) ?? p.items[cctMode ? 1 : 0] ?? ""
      : cctMode ? "1" : "0";
    void ctl.send(colorCmd, fillParams(colorCmd.def, [
      [/(^|_)X$/i, () => xy[0].toFixed(4)],
      [/(^|_)Y$/i, () => xy[1].toFixed(4)],
      [/MODE/i, modeValue],
      [/RATE|TIME|DURATION/i, (p) => initialValue(p) || "0"],
      [/HUE/i, () => String(Math.round(extra.h ?? 0))],
      [/SAT/i, () => String(Math.round((extra.s ?? 0) * 100))],
      [/KELVIN|CCT|TEMP/i, () => String(Math.round(extra.k ?? 0))],
      [/RGB|COLOR$/i, () => [r, g, b].map((n) => Math.round(n * 255)).join(",")],
    ], [
      { name: "LIGHT_COLOR_TARGET_X", type: "FLOAT", value: xy[0].toFixed(4) },
      { name: "LIGHT_COLOR_TARGET_Y", type: "FLOAT", value: xy[1].toFixed(4) },
      { name: "LIGHT_COLOR_TARGET_MODE", type: "INTEGER", value: cctMode ? "1" : "0" },
      { name: "LIGHT_COLOR_TARGET_RATE", type: "INTEGER", value: "0" },
    ]));
  };
  const sendHs = useThrottle(({ h, s }: { h: number; s: number }) => sendXy(rgbToXy(hsvToRgb(h, s)), false, { h, s }));
  const sendK = useThrottle((k: number) => {
    if (!colorCmd && cctCmd) {
      void ctl.send(cctCmd, fillParams(cctCmd.def, [[/KELVIN|CCT|TEMP|VALUE/i, () => String(k)]], [{ name: "KELVIN", type: "INTEGER", value: String(k) }]));
    } else sendXy(kelvinToXy(k), true, { k });
  });

  const pickHs = (v: { h: number; s: number }, final: boolean) => {
    holdHs(v);
    holdMode("color");
    if (final) sendHs.flush(v); else sendHs.push(v);
  };
  const pickK = (k: number, final: boolean) => {
    holdK(k);
    holdMode("cct");
    if (final) sendK.flush(k); else sendK.push(k);
  };

  const powered = powerHeld;
  const shownRgb: Rgb = mode === "cct" && kelvin != null ? xyToRgb(...kelvinToXy(kelvin))
    : hs ? hsvToRgb(hs.h, hs.s) : xyToRgb(...kelvinToXy(kelvin ?? 2900));
  const glow = cssRgb(shownRgb);
  const powerKey = toggle ?? (powered ? off : on) ?? on ?? off;
  const pressPower = () => {
    if (!powerKey) return;
    holdPower(powerKey === off ? false : powerKey === on ? true : !powered);
    void ctl.send(powerKey);
  };

  return (
    <div className={cx("rc-light", powered === false && "off")} style={{ "--rc-glow": glow } as React.CSSProperties}>
      <div className="rc-light-head">
        <button type="button" className={cx("rc-bulb", powered && "on")} aria-label={powered ? "Turn off" : "Turn on"} aria-pressed={powered === true}
                disabled={ctl.disabled || !powerKey} onClick={pressPower}
                title={ctl.why ?? `${powerKey?.def.name ?? "No power command"}${powerKey?.standard ? " (standard command)" : ""}`}>
          <Power size={26} strokeWidth={2.2} />
        </button>
        <div className="rc-light-title">
          <b>{powered == null ? "—" : powered ? "On" : "Off"}</b>
          <span className="dim small">
            {[st.level != null && `${Math.round(st.level)}%`, mode === "cct" && kelvin != null ? `${Math.round(kelvin)} K` : mode === "color" && hs ? "Colour" : null]
              .filter(Boolean).join(" · ") || "Level not reported"}
          </span>
        </div>
        <span className="grow" />
        {on && off && (
          <div className="rc-power" role="group" aria-label="Power">
            <Key ctl={ctl} a={on} label="On" className="rc-pill" on={powered === true}>On</Key>
            <Key ctl={ctl} a={off} label="Off" className="rc-pill" on={powered === false}>Off</Key>
          </div>
        )}
      </div>

      {level && (
        <div className="rc-block">
          <div className="rc-cap"><Sun size={12} strokeWidth={2} />Brightness</div>
          <LevelSlider ctl={ctl} a={level} value={st.level} label="Brightness" unit="%" fill={glow}
                       icons={[<SunDim key="lo" size={16} strokeWidth={1.8} className="dim" />, <Sun key="hi" size={18} strokeWidth={1.8} className="dim" />]} />
        </div>
      )}

      {color && colorCmd && (
        <div className="rc-block">
          <div className="rc-cap"><Palette size={12} strokeWidth={2} />Colour</div>
          <div className="rc-color-row">
            <ColorWheel value={hs} active={mode !== "cct"} disabled={ctl.disabled} onPick={pickHs} why={ctl.why} />
            <div className="rc-swatches">
              {SWATCHES.filter((s) => s.k == null || cct).map((s) => {
                const rgb = s.k != null ? xyToRgb(...kelvinToXy(s.k)) : hsvToRgb(s.h!, s.s!);
                return (
                  <button key={s.label} type="button" className="rc-swatch" style={{ background: cssRgb(rgb) }} disabled={ctl.disabled}
                          aria-label={s.label} title={ctl.why ?? s.label}
                          onClick={() => (s.k != null ? pickK(Math.max(kMin, Math.min(kMax, s.k)), true) : pickHs({ h: s.h!, s: s.s! }, true))} />
                );
              })}
            </div>
          </div>
        </div>
      )}

      {cct && (colorCmd || cctCmd) && (
        <div className="rc-block">
          <div className="rc-cap"><Thermometer size={12} strokeWidth={2} />Colour temperature</div>
          <KelvinSlider value={kelvin} min={kMin} max={kMax} active={mode !== "color"} disabled={ctl.disabled} why={ctl.why} onPick={pickK} />
        </div>
      )}
      {!level && !color && !cct && !on && !off && !toggle && <p className="dim small flush-p">This light lists no commands to control it with.</p>}
    </div>
  );
}

/** Hue around the wheel (red at the top, clockwise), saturation from the centre out. Drag the
 *  thumb, click anywhere, or use the arrow keys (←→ hue, ↑↓ saturation; Shift for big steps). */
function ColorWheel({ value, active, disabled, why, onPick }: {
  value: { h: number; s: number } | null; active: boolean; disabled: boolean; why?: string; onPick: (v: { h: number; s: number }, final: boolean) => void;
}) {
  const SIZE = 196;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ h: number; s: number } | null>(null);
  const shown = drag ?? value;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const n = Math.round(SIZE * dpr);
    c.width = n;
    c.height = n;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(n, n);
    const r = n / 2;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - r, dy = y + 0.5 - r;
        const d = Math.hypot(dx, dy);
        const i = (y * n + x) * 4;
        if (d > r) continue;
        const h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
        const [R, G, B] = hsvToRgb(h, Math.min(1, d / r));
        img.data[i] = R * 255;
        img.data[i + 1] = G * 255;
        img.data[i + 2] = B * 255;
        img.data[i + 3] = Math.max(0, Math.min(1, r - d)) * 255; // a soft edge
      }
    }
    ctx.putImageData(img, 0, 0);
  }, []);

  const at = (e: React.PointerEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - box.left - box.width / 2, dy = e.clientY - box.top - box.height / 2;
    return { h: ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360, s: Math.min(1, Math.hypot(dx, dy) / (box.width / 2)) };
  };
  const move = (v: { h: number; s: number }, final: boolean) => {
    setDrag(final ? null : v);
    onPick(v, final);
  };
  const key = (e: React.KeyboardEvent, final: boolean) => {
    const base = shown ?? { h: 0, s: 0 };
    const big = e.shiftKey;
    const next = {
      ArrowLeft: { h: (base.h - (big ? 30 : 5) + 360) % 360, s: Math.max(base.s, 0.05) },
      ArrowRight: { h: (base.h + (big ? 30 : 5)) % 360, s: Math.max(base.s, 0.05) },
      ArrowUp: { h: base.h, s: Math.min(1, base.s + (big ? 0.2 : 0.05)) },
      ArrowDown: { h: base.h, s: Math.max(0, base.s - (big ? 0.2 : 0.05)) },
    }[e.key];
    if (!next) return;
    e.preventDefault();
    if (final) move(base, true);
    else move(next, false);
  };
  const rad = ((shown?.h ?? 0) * Math.PI) / 180, rr = (shown?.s ?? 0) * 50;
  return (
    <div className={cx("rc-wheel", !active && "idle")} role="slider" tabIndex={disabled ? -1 : 0} aria-label="Colour" aria-disabled={disabled}
         aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(shown?.h ?? 0)}
         aria-valuetext={shown ? `Hue ${Math.round(shown.h)}°, saturation ${Math.round(shown.s * 100)}%` : "Not reported"}
         title={why} style={{ width: SIZE, height: SIZE }}
         onPointerDown={(e) => { if (disabled || e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); move(at(e), false); }}
         onPointerMove={(e) => { if (drag && !disabled) move(at(e), false); }}
         onPointerUp={(e) => { if (drag && !disabled) move(at(e), true); }}
         onPointerCancel={() => setDrag(null)}
         onKeyDown={(e) => !disabled && key(e, false)} onKeyUp={(e) => !disabled && key(e, true)}>
      <canvas ref={canvas} style={{ width: SIZE, height: SIZE }} aria-hidden />
      {shown && (
        <span className={cx("rc-thumb", drag && "dragging")} aria-hidden
              style={{ left: `${50 + Math.sin(rad) * rr}%`, top: `${50 - Math.cos(rad) * rr}%`, background: cssRgb(hsvToRgb(shown.h, shown.s)) }} />
      )}
    </div>
  );
}

/** Warm (left) to cool (right), drawn with the colours the bulb will actually show. */
function KelvinSlider({ value, min, max, active, disabled, why, onPick }: {
  value: number | null; min: number; max: number; active: boolean; disabled: boolean; why?: string; onPick: (k: number, final: boolean) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value ?? Math.round((min + max) / 2);
  const stops = Array.from({ length: 7 }, (_, i) => {
    const k = min + ((max - min) * i) / 6;
    return `${cssRgb(xyToRgb(...kelvinToXy(k)))} ${(i / 6) * 100}%`;
  }).join(", ");
  const end = (k: number) => { setDrag(null); onPick(k, true); };
  return (
    <div className={cx("rc-level", !active && "idle")}>
      <span className="dim small">Warm</span>
      <input type="range" className="rc-slider kelvin" min={min} max={max} step={50} value={shown} disabled={disabled} aria-label="Colour temperature"
             aria-valuetext={`${shown} kelvin`} title={why}
             style={{ "--rc-track": `linear-gradient(90deg, ${stops})` } as React.CSSProperties}
             onChange={(e) => { const k = Number(e.target.value); setDrag(k); onPick(k, false); }}
             onPointerUp={(e) => end(Number((e.target as HTMLInputElement).value))}
             onKeyUp={(e) => { if (/Arrow|Page|Home|End/.test(e.key)) end(Number((e.target as HTMLInputElement).value)); }} />
      <span className="dim small">Cool</span>
      <span className="mono rc-level-num">{value == null && drag == null ? "—" : `${Math.round(shown)} K`}</span>
    </div>
  );
}

// ---- matrix ------------------------------------------------------------------------------------

function Matrix({ ctl, route }: { ctl: Ctl; route: NonNullable<ReturnType<typeof routeCommand>> }) {
  const inputs = useMemo(() => matrixPorts(route.input, ctl.connections, "input"), [route.input, ctl.connections]);
  const outputs = useMemo(() => matrixPorts(route.output, ctl.connections, "output"), [route.output, ctl.connections]);
  const live = routesFrom(ctl.vars, inputs, outputs);
  const [sent, setSent] = useState<Map<string, string>>(new Map());
  const powerState = stateOf(ctl.vars, "POWER_STATE", "POWER");
  const hasPower = !!findCommand(ctl.available, ...K.on, ...K.off, ...K.toggle);

  const go = (i: Port, o: Port) => {
    setSent((m) => new Map(m).set(o.key, i.key));
    const inName = route.input?.name ?? "INPUT", outName = route.output?.name ?? "OUTPUT";
    void ctl.send(route.a, fillParams(route.a.def, [
      [new RegExp(`^${outName}$`), () => o.value],
      [new RegExp(`^${inName}$`), () => i.value],
      [/^(AUDIO|VIDEO)$/i, (p) => p.default ?? "True"],
    ], [{ name: "INPUT", type: "INTEGER", value: i.value }, { name: "OUTPUT", type: "INTEGER", value: o.value }]));
  };

  return (
    <div className="rc-matrix-wrap">
      {hasPower && (
        <div className="rc-row">
          <PowerKeys ctl={ctl} powered={powerState == null ? null : isOn(powerState)} />
        </div>
      )}
      {!inputs.length || !outputs.length ? (
        <p className="dim small flush-p">
          {route.a.def.name} routes inputs to outputs, but the driver lists no {!inputs.length ? "inputs" : "outputs"} to draw a grid from.
          Send it from All commands with the input and output you want.
        </p>
      ) : (
        <>
          <div className="rc-matrix" role="grid" aria-label="Routes: outputs down, inputs across">
            <table>
              <thead>
                <tr>
                  <th className="corner"><span className="dim small">Output ↓ · Input →</span></th>
                  {inputs.map((i) => <th key={i.key} scope="col" title={i.detail || i.label}><span>{i.label}</span>{i.detail && <small>{i.detail}</small>}</th>)}
                </tr>
              </thead>
              <tbody>
                {outputs.map((o) => {
                  const now = live.get(o.key);
                  const mine = now == null ? sent.get(o.key) : undefined;
                  return (
                    <tr key={o.key}>
                      <th scope="row" title={o.detail || o.label}><span>{o.label}</span>{o.detail && <small>{o.detail}</small>}</th>
                      {inputs.map((i) => {
                        const on = now === i.key, guess = mine === i.key;
                        return (
                          <td key={i.key}>
                            <button type="button" className={cx("rc-cell", on && "on", guess && "sent")} disabled={ctl.disabled} aria-pressed={on || guess}
                                    aria-label={`Route ${i.label} to ${o.label}`} title={ctl.why ?? `${i.label} → ${o.label} (${route.a.def.name})`}
                                    onClick={() => go(i, o)}>
                              {on || guess ? <Check size={15} strokeWidth={2.6} /> : <Dot size={18} strokeWidth={2.4} />}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="dim small flush-p">
            {live.size
              ? "Filled cells are the routes the driver reports; click a cell to route that input to that output."
              : "The driver reports no routing state, so ticks show what you sent from here, not what the matrix is doing."}
          </p>
        </>
      )}
    </div>
  );
}

// ---- everything else the driver can do ---------------------------------------------------------

/** The driver's other buttons (commands that take nothing) and choices (one list parameter),
 *  so the remote has every key without opening All commands. */
function Extras({ ctl, layout }: { ctl: Ctl; layout: Layout }) {
  const placed = layout === "light" ? LIGHT_PLACED : layout === "generic" ? QUICK_PLACED : layout === "switch" ? new Set([...K.on, ...K.off, ...K.toggle]) : REMOTE_PLACED;
  const seen = new Set<string>();
  const mine = ctl.available.filter((a) => {
    const n = normName(a.def.name);
    if (a.standard || placed.has(n) || seen.has(`${a.target}:${n}`)) return false;
    seen.add(`${a.target}:${n}`);
    return true;
  });
  const keys = mine.filter((a) => !a.def.params.length);
  const lists = mine.filter((a) => a.def.params.length === 1 && paramType(a.def.params[0]) === "LIST" && a.def.params[0].items.length);
  if (!keys.length && !lists.length) return null;
  const rest = mine.some((a) => a.def.params.length && !lists.includes(a));
  return (
    <section className="control-card rc-extras">
      <div className="control-card-head"><Grid3x3 size={13} strokeWidth={1.8} />More from this driver</div>
      {!!keys.length && (
        <div className="rc-keys">
          {keys.map((a) => (
            <Key key={`${a.target}:${a.def.name}`} ctl={ctl} a={a} label={humanize(a.def.name)} className="rc-pill">{humanize(a.def.name)}</Key>
          ))}
        </div>
      )}
      {lists.map((a) => (
        <div key={`${a.target}:${a.def.name}`} className="q-row">
          <span className="q-label">{humanize(a.def.name.replace(/^SET_/i, ""))}</span>
          <div className="q-ctl"><ListPick a={a} current={null} send={ctl.send} disabled={ctl.disabled} /></div>
        </div>
      ))}
      {rest && <p className="dim small flush-p">Commands that need values are under All commands.</p>}
    </section>
  );
}

// ---- quick controls (devices without a remote of their own) ------------------------------------

function Quick({ family, available, vars, send, disabled, why, d }: {
  family: Family; available: Available[]; vars: LiveVar[]; send: Send; disabled: boolean; why?: string; d: ItemDetail;
}) {
  const on = findCommand(available, "ON");
  const off = findCommand(available, "OFF");
  const powered = family === "light" ? stateOf(vars, "LIGHT_STATE") ?? stateOf(vars, "POWER_STATE") : stateOf(vars, "POWER_STATE", "POWER");
  const level = findCommand(available, "SET_LEVEL", "RAMP_TO_LEVEL");
  const volume = findCommand(available, "SET_VOLUME_LEVEL");
  const volUp = findCommand(available, "PULSE_VOL_UP");
  const volDown = findCommand(available, "PULSE_VOL_DOWN");
  const muteToggle = findCommand(available, "MUTE_TOGGLE");
  const muteOn = findCommand(available, "MUTE_ON");
  const muteOff = findCommand(available, "MUTE_OFF");
  const input = findCommand(available, "SET_INPUT");
  const transport = ["PLAY", "PAUSE", "STOP", "SKIP_REV", "SKIP_FWD"].map((n) => findCommand(available, n)).filter((x): x is Available => !!x);
  const heat = findCommand(available, "SET_SETPOINT_HEAT");
  const cool = findCommand(available, "SET_SETPOINT_COOL");
  const hvac = findCommand(available, "SET_MODE_HVAC");
  const muted = isOn(stateOf(vars, "MUTE_STATE", "MUTE"));

  const rows: React.ReactNode[] = [];
  if (on || off) {
    rows.push(
      <QRow key="power" label="Power" icon={<Power size={13} strokeWidth={1.8} />}>
        <div className="seg">
          {on && <QBtn a={on} send={send} disabled={disabled} why={why} on={powered != null && isOn(powered)}>On</QBtn>}
          {off && <QBtn a={off} send={send} disabled={disabled} why={why} on={powered != null && !isOn(powered)}>Off</QBtn>}
        </div>
      </QRow>,
    );
  }
  if (level && family !== "av") {
    rows.push(
      <QRow key="level" label="Level">
        <Level a={level} value={numberOf(stateOf(vars, "LIGHT_LEVEL", "LEVEL"))} send={send} disabled={disabled} why={why} unit="%" />
      </QRow>,
    );
  }
  if (volume || volUp || volDown) {
    rows.push(
      <QRow key="vol" label="Volume" icon={<Volume2 size={13} strokeWidth={1.8} />}>
        <div className="row nowrap q-vol">
          {volDown && <QIcon a={volDown} send={send} disabled={disabled} why={why} label="Volume down"><Minus size={13} strokeWidth={2} /></QIcon>}
          {volume && <Level a={volume} value={numberOf(stateOf(vars, "VOLUME_LEVEL", "VOLUME"))} send={send} disabled={disabled} why={why} />}
          {volUp && <QIcon a={volUp} send={send} disabled={disabled} why={why} label="Volume up"><Plus size={13} strokeWidth={2} /></QIcon>}
          {(muteToggle || muteOn || muteOff) && (
            <QIcon a={(muteToggle ?? (muted ? muteOff : muteOn) ?? muteOn ?? muteOff)!} send={send} disabled={disabled} why={why}
                   label={muted ? "Unmute" : "Mute"} on={muted}>
              {muted ? <VolumeX size={14} strokeWidth={1.8} /> : <Volume2 size={14} strokeWidth={1.8} />}
            </QIcon>
          )}
        </div>
      </QRow>,
    );
  }
  if (input) rows.push(<QRow key="input" label="Input"><InputPick a={input} d={d} current={stateOf(vars, "CURRENT_INPUT", "INPUT")} send={send} disabled={disabled} /></QRow>);
  if (transport.length) {
    const ICON: Record<string, React.ReactNode> = {
      PLAY: <Play size={13} strokeWidth={1.8} />, PAUSE: <Pause size={13} strokeWidth={1.8} />, STOP: <Square size={12} strokeWidth={1.8} />,
      SKIP_REV: <SkipBack size={13} strokeWidth={1.8} />, SKIP_FWD: <SkipForward size={13} strokeWidth={1.8} />,
    };
    rows.push(
      <QRow key="transport" label="Playback">
        <div className="row nowrap">
          {transport.map((a) => <QIcon key={a.def.name} a={a} send={send} disabled={disabled} why={why} label={a.def.name.toLowerCase().replace("_", " ")}>{ICON[a.def.name]}</QIcon>)}
          <span className="dim small">{stateOf(vars, "PLAY_STATE") ?? ""}</span>
        </div>
      </QRow>,
    );
  }
  if (heat) rows.push(<QRow key="heat" label="Heat to"><Stepper a={heat} value={numberOf(stateOf(vars, "HEAT_SETPOINT_F", "HEAT_SETPOINT_C", "HEAT_SETPOINT"))} send={send} disabled={disabled} why={why} /></QRow>);
  if (cool) rows.push(<QRow key="cool" label="Cool to"><Stepper a={cool} value={numberOf(stateOf(vars, "COOL_SETPOINT_F", "COOL_SETPOINT_C", "COOL_SETPOINT"))} send={send} disabled={disabled} why={why} /></QRow>);
  if (hvac?.def.params[0]?.items.length) {
    rows.push(<QRow key="hvac" label="Mode"><ListPick a={hvac} current={stateOf(vars, "HVAC_MODE")} send={send} disabled={disabled} /></QRow>);
  }

  if (!rows.length) {
    return <p className="dim small flush-p">No standard controls for this kind of device — its own buttons are below, and every command is under All commands.</p>;
  }
  return <div className="quick">{rows}</div>;
}

function QRow({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return <div className="q-row"><span className="q-label">{icon}{label}</span><div className="q-ctl">{children}</div></div>;
}

/** A button that sends one command with no parameters. */
function QBtn({ a, send, disabled, why, on, children }: { a: Available; send: Send; disabled: boolean; why?: string; on?: boolean; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <Tip text={why ?? `${a.def.name} → ${a.targetName}${a.standard ? " (standard command)" : ""}`}>
      <span><button className={cx("act small", on && "on")} disabled={disabled || busy}
                    onClick={async () => { setBusy(true); await send(a); setBusy(false); }}>{busy && <Spinner />}{children}</button></span>
    </Tip>
  );
}

function QIcon({ a, send, disabled, why, label, on, children }: {
  a: Available; send: Send; disabled: boolean; why?: string; label: string; on?: boolean; children: React.ReactNode;
}) {
  return (
    <Tip text={why ?? `${label} (${a.def.name})`}>
      <span><button className={cx("q-icon", on && "on")} aria-label={label} disabled={disabled} onClick={() => void send(a)}>{children}</button></span>
    </Tip>
  );
}

/** A 0–100 (or declared range) slider that sends its value when let go, not on every pixel. */
function Level({ a, value, send, disabled, why, unit = "" }: { a: Available; value: number | null; send: Send; disabled: boolean; why?: string; unit?: string }) {
  const def = a.def.params.find((x) => /LEVEL|VALUE/.test(x.name)) ?? a.def.params[0];
  const lo = Number(def?.minimum ?? 0), hi = Number(def?.maximum ?? 100);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value ?? lo;
  const commit = (n: number) => {
    setDrag(null);
    if (!def) return;
    const params: CommandParam[] = [{ name: def.name, type: paramType(def), value: String(n) }];
    // RAMP_TO_LEVEL also wants a time; use its default.
    for (const extra of a.def.params) if (extra !== def) params.push({ name: extra.name, type: paramType(extra), value: initialValue(extra) || "0" });
    void send(a, params);
  };
  return (
    <Tip text={why}>
      <span className="q-level">
        <input type="range" min={lo} max={hi} value={shown} disabled={disabled || !def} aria-label={a.def.name}
               style={{ "--pct": `${hi > lo ? ((shown - lo) / (hi - lo)) * 100 : 0}%` } as React.CSSProperties}
               onChange={(e) => setDrag(Number(e.target.value))}
               onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
               onKeyUp={(e) => { if (/Arrow|Page|Home|End/.test(e.key)) commit(Number((e.target as HTMLInputElement).value)); }} />
        <span className="mono q-num">{value == null && drag == null ? "—" : `${Math.round(shown)}${unit}`}</span>
      </span>
    </Tip>
  );
}

function Stepper({ a, value, send, disabled, why }: { a: Available; value: number | null; send: Send; disabled: boolean; why?: string }) {
  const def = a.def.params[0];
  const go = (n: number) => def && void send(a, [{ name: def.name, type: paramType(def), value: String(n) }]);
  const lo = def?.minimum != null ? Number(def.minimum) : -Infinity, hi = def?.maximum != null ? Number(def.maximum) : Infinity;
  return (
    <Tip text={why}>
      <span className="row nowrap">
        <button className="q-icon" aria-label="Lower" disabled={disabled || value == null || value <= lo} onClick={() => value != null && go(value - 1)}><Minus size={13} strokeWidth={2} /></button>
        <span className="mono q-num big">{value ?? "—"}°</span>
        <button className="q-icon" aria-label="Raise" disabled={disabled || value == null || value >= hi} onClick={() => value != null && go(value + 1)}><Plus size={13} strokeWidth={2} /></button>
      </span>
    </Tip>
  );
}

function ListPick({ a, current, send, disabled }: { a: Available; current: string | null; send: Send; disabled: boolean }) {
  const def = a.def.params[0];
  return (
    <Select value={current && def.items.includes(current) ? current : ""} disabled={disabled} label={a.def.name} placeholder={current ?? "Choose…"}
            options={def.items.map((o) => ({ value: o, label: o }))}
            onValueChange={(v) => void send(a, [{ name: def.name, type: paramType(def), value: v }])} />
  );
}

/** Inputs from the command's own list, or else the device's video/audio inputs (by binding id,
 *  which is what Control4's SET_INPUT takes). */
function InputPick({ a, d, current, send, disabled }: { a: Available; d: ItemDetail; current: string | null; send: Send; disabled: boolean }) {
  const def = a.def.params.find((x) => x.name === "INPUT") ?? a.def.params[0];
  if (def?.items.length) return <ListPick a={a} current={current} send={send} disabled={disabled} />;
  const inputs = d.connections.filter((c) => c.role === "input" && c.classes.some((k) => /HDMI|VIDEO|AUDIO|COMPONENT|COMPOSITE|DIGITAL|STEREO/.test(k)));
  if (!inputs.length) return <span className="dim small">No inputs listed{current ? ` · now ${current}` : ""}</span>;
  return (
    <Select value={inputs.find((c) => String(c.id) === current || c.name === current) ? String(inputs.find((c) => String(c.id) === current || c.name === current)!.id) : ""}
            disabled={disabled} label="Input" placeholder={current ?? "Choose…"}
            options={inputs.map((c) => ({ value: String(c.id), label: c.name }))}
            onValueChange={(v) => void send(a, [{ name: def?.name ?? "INPUT", type: def ? paramType(def) : "INTEGER", value: v }])} />
  );
}

// ---- every command -----------------------------------------------------------------------------

function Commands({ available, name, send, disabled, why }: { available: Available[]; name: string; send: Send; disabled: boolean; why?: string }) {
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const shown = available.filter((a) => !q || `${a.def.name} ${a.def.description}`.toLowerCase().includes(q));
  const groups = [...new Map(shown.map((a) => [a.target, a])).values()];
  return (
    <section className="control-cmds">
      <div className="control-card-head">
        <span>Commands</span>
        {available.length > 6 && (
          <span className="search-box inline q-filter"><Search size={12} strokeWidth={1.8} />
            <input placeholder="Filter commands…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter commands" />
          </span>
        )}
      </div>
      {!available.length && <p className="dim small flush-p">This driver declares no commands.</p>}
      {available.length > 0 && !shown.length && <p className="dim small flush-p">No command matches “{filter}”.</p>}
      {groups.map((g) => (
        <div key={g.target} className="cmd-group">
          {groups.length > 1 || g.role !== "device" ? (
            <div className="cmd-owner">{g.targetName}<span className="tag">{g.role}</span></div>
          ) : null}
          {shown.filter((a) => a.target === g.target).map((a) => (
            <CommandRow key={`${a.target}:${a.def.name}`} a={a} name={name} send={send} disabled={disabled} why={why} />
          ))}
        </div>
      ))}
    </section>
  );
}

function CommandRow({ a, name, send, disabled, why }: { a: Available; name: string; send: Send; disabled: boolean; why?: string }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(a.def.params.map((p) => [p.name, initialValue(p)])));
  const [busy, setBusy] = useState(false);
  const problems = a.def.params.map((p) => paramProblem(p, values[p.name] ?? ""));
  const bad = problems.some(Boolean);
  const go = async () => {
    if (bad || disabled) return;
    setBusy(true);
    await send(a, a.def.params.map((p) => ({ name: p.name, type: paramType(p), value: values[p.name] ?? "" })));
    setBusy(false);
  };
  const described = describe(a.def, name);
  return (
    <div className="cmd" onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); void go(); } }}>
      <div className="cmd-name">
        <span className="mono">{a.def.name}</span>
        {a.standard && <Tip text="Control4's standard command for this proxy type"><span className="tag">standard</span></Tip>}
        {described && <span className="dim small cmd-desc" title={described}>{described}</span>}
      </div>
      <div className="cmd-params">
        {a.def.params.map((p, i) => (
          <ParamInput key={p.name} p={p} value={values[p.name] ?? ""} problem={problems[i]} disabled={disabled}
                      onChange={(v) => setValues((x) => ({ ...x, [p.name]: v }))} />
        ))}
        <Tip text={why ?? (bad ? problems.find(Boolean) : `Send ${a.def.name} to ${a.targetName}`)}>
          <span><button className="act small primary" disabled={disabled || bad || busy} onClick={() => void go()}>
            {busy ? <Spinner /> : <Send size={12} strokeWidth={1.8} />}Send
          </button></span>
        </Tip>
      </div>
    </div>
  );
}

/** Composer's description template, with the device's name in it. */
function describe(def: CommandDef, name: string): string {
  const t = def.description.trim();
  return t && t !== def.name ? t.replace(/\bNAME\b/g, name) : "";
}

function ParamInput({ p, value, problem, disabled, onChange }: {
  p: ParamDef; value: string; problem: string | null; disabled: boolean; onChange: (v: string) => void;
}) {
  const t = paramType(p);
  const label = <span className="param-name">{p.name}</span>;
  if (t === "LIST" && p.items.length) {
    return <label className="param">{label}<Select value={value} onValueChange={onChange} disabled={disabled} label={p.name} options={p.items.map((o) => ({ value: o, label: o }))} /></label>;
  }
  if (t === "BOOL" || t === "BOOLEAN") {
    return <label className="param">{label}<Switch checked={/^(1|true)$/i.test(value)} disabled={disabled} label={p.name} onCheckedChange={(c) => onChange(c ? "True" : "False")} /></label>;
  }
  const numeric = t.includes("INTEGER") || t.includes("FLOAT") || t === "NUMBER";
  const ranged = numeric && p.minimum != null && p.maximum != null;
  return (
    <label className={cx("param", problem && value !== "" && "bad")}>
      {label}
      {ranged && (
        <input type="range" className="param-range" min={Number(p.minimum)} max={Number(p.maximum)} step={t.includes("FLOAT") ? 0.5 : 1}
               value={Number.isFinite(Number(value)) && value !== "" ? Number(value) : Number(p.minimum)} disabled={disabled}
               onChange={(e) => onChange(e.target.value)} aria-label={`${p.name} slider`} />
      )}
      <input className={cx(numeric && "mono", "param-input", numeric && "num")} value={value} disabled={disabled} inputMode={numeric ? "decimal" : undefined}
             placeholder={ranged ? `${p.minimum}–${p.maximum}` : t.toLowerCase()} onChange={(e) => onChange(e.target.value)} aria-label={p.name} />
    </label>
  );
}
