/** Composer's proxy control, modernised: a device's live state, quick controls for what it is
 *  (a light's level, a receiver's volume and input…), and every command its driver declares,
 *  with parameter inputs. Commands from here are the user's own clicks, so they are sent at
 *  once — no approval card — and each one is logged with Director's reply. Read-only Directors
 *  can be looked at, not controlled. */

import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle, Check, Gauge, Minus, Pause, Play, Plus, Power, RefreshCw, Search, Send, SkipBack, SkipForward, Square, Volume2,
  VolumeX, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errText, type CommandDef, type CommandParam, type ItemDetail, type ParamDef } from "../../api";
import { Tip } from "../../components/Dialogs";
import { Select, Spinner, Switch } from "../../components/controls";
import { DriverIcon } from "../../components/icons";
import { ReadOnlyLock } from "../../components/shell";
import {
  STANDARD, familyOf, findCommand, initialValue, isOn, numberOf, paramProblem, paramType, parseVariables, stateOf,
  type Available, type Family, type LiveVar,
} from "../../lib/control";
import type { Shell } from "../../lib/shell";
import { cx, time } from "../../lib/ui";

/** How often the state is read while the panel is open. */
const POLL_MS = 3000;

interface Sent {
  n: number;
  at: string;
  target: string;
  command: string;
  params: CommandParam[];
  state: "sending" | "ok" | "error";
  reply: string;
}

type Send = (a: Available, params?: CommandParam[]) => Promise<void>;

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

function Panel({ id, shell, onClose }: { id: number; shell: Shell; onClose: () => void }) {
  // The item and its proxies: commands and state live on both.
  const [items, setItems] = useState<ItemDetail[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [vars, setVars] = useState<LiveVar[]>([]);
  const [stateError, setStateError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<Sent[]>([]);
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

  // Every command, by where it goes. A proxy that declares nothing gets its family's standard
  // commands, which Director understands for its built-in proxies.
  const available: Available[] = useMemo(() => (items ?? []).flatMap((x, i) => {
    const role = i === 0 && x.kind !== "proxy" ? "device" : (x.driver ?? "proxy").replace(/\.c4[iz]$/i, "");
    const own = (x.commands ?? []).map((def) => ({ target: x.id, targetName: x.name, role, def, standard: false }));
    if (own.length || (i === 0 && x.kind !== "proxy")) return own;
    return STANDARD[familyOf([x.driver])].map((def) => ({ target: x.id, targetName: x.name, role, def, standard: true }));
  }), [items]);

  const send: Send = useCallback(async (a, params = []) => {
    const n = ++seq.current;
    const entry: Sent = { n, at: new Date().toISOString(), target: a.targetName, command: a.def.name, params, state: "sending", reply: "" };
    setLog((l) => [entry, ...l].slice(0, 40));
    const done = (patch: Partial<Sent>) => setLog((l) => l.map((x) => (x.n === n ? { ...x, ...patch } : x)));
    try {
      const r = await api.sendCommand(a.target, a.def.name, params);
      done({ state: "ok", reply: r.reply.join(" · ") });
    } catch (e) {
      done({ state: "error", reply: errText(e) });
    }
    // Devices report back a moment later; read now and once more after that.
    void read();
    setTimeout(() => void read(), 900);
  }, [read]);

  if (!d) {
    return (
      <>
        <Dialog.Title className="sr-only">Device control</Dialog.Title>
        {loadError ? <div className="control-body"><p className="err">{loadError}</p></div> : <div className="loading"><Spinner size="lg" /><span>Reading the device…</span></div>}
      </>
    );
  }

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

      <div className="control-body">
        <div className="control-top">
          <section className="control-card">
            <div className="control-card-head"><Gauge size={13} strokeWidth={1.8} />Quick controls</div>
            <Quick family={family} available={available} vars={vars} send={send} disabled={!writable} why={why} d={d} />
          </section>
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
                    <span className="mono k" title={v.owner !== d.id ? (items?.find((x) => x.id === v.owner)?.name ?? "") : undefined}>{v.name}</span>
                    <span className="mono v">{v.value === "" ? <i className="dim">empty</i> : v.value}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {!!log.length && (
          <section className="control-log" aria-label="Sent commands">
            <div className="control-card-head"><Send size={13} strokeWidth={1.8} />Sent
              <button className="act small quiet spread" onClick={() => setLog([])}>Clear</button>
            </div>
            {log.map((s) => (
              <div key={s.n} className={cx("log-row", s.state)}>
                <span className="dim mono small">{time(s.at)}</span>
                <span className="log-icon">{s.state === "sending" ? <Spinner /> : s.state === "ok" ? <Check size={13} strokeWidth={2} /> : <AlertTriangle size={13} strokeWidth={1.8} />}</span>
                <span className="mono log-cmd">{s.command}{s.params.length ? `(${s.params.map((p) => `${p.name}=${p.value}`).join(", ")})` : ""}</span>
                <span className="dim small">→ {s.target}</span>
                <span className={cx("log-reply small", s.state === "error" ? "err" : "dim")}>{s.state === "ok" ? (s.reply || "sent") : s.reply}</span>
              </div>
            ))}
          </section>
        )}

        <Commands available={available} name={d.name} send={send} disabled={!writable} why={why} />

      </div>
      <div className="control-foot">
        <span className="dim small">Commands go straight to the device — they change no project data, so there's no approval card.</span>
        <button className="act" onClick={onClose}>Done</button>
      </div>
    </>
  );
}

// ---- quick controls ----------------------------------------------------------------------------

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
    return <p className="dim small flush-p">No quick controls for this kind of device — its commands are below.</p>;
  }
  return (
    <div className="quick">
      {rows}
      {available.some((a) => a.standard) && (
        <p className="dim small flush-p">Some controls use Control4's standard proxy commands; the proxy didn't list its own.</p>
      )}
    </div>
  );
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
