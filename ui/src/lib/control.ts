/** Device control without the UI: reading a device's live variables, telling what kind of
 *  device it is, finding the commands its remote sends, and the arithmetic behind the remotes
 *  (light colours, matrix routes). No components here (pages/design/DeviceControl.tsx draws
 *  the panel). */

import type { CommandDef, CommandParam, ConnectionDef, ParamDef } from "../api/types.ts";

export interface LiveVar {
  /** The item the variable belongs to (a device or one of its proxies). */
  owner: number;
  id: string;
  name: string;
  value: string;
}

/** GetVariablesByDevice as the backend hands it over (Director's XML as JSON). Director answers
 *  `<variable variableid=".." name="..">value</variable>`; elements instead of attributes are
 *  read the same way, so a firmware that nests them doesn't come up empty. */
export function parseVariables(json: unknown, owner: number): LiveVar[] {
  const out: LiveVar[] = [];
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const name = str(o["@name"]) ?? str(o.name);
    const id = str(o["@variableid"]) ?? str(o["@id"]) ?? str(o.variableid) ?? str(o.id);
    if (name && id != null) {
      out.push({ owner, id, name, value: str(o["#text"]) ?? str(o.value) ?? str(o["@value"]) ?? "" });
      return;
    }
    for (const [k, x] of Object.entries(o)) if (!k.startsWith("@")) walk(x);
  };
  walk(json);
  return out;
}

/** What a device is, for its remote: Control4's proxy families. */
export type Family = "light" | "av" | "switch" | "tv" | "media" | "thermostat" | "generic";

const proxyName = (x: string) => x.toLowerCase().replace(/\.c4[iz]$/, "");

export function familyOf(proxies: (string | null | undefined)[]): Family {
  const p = proxies.filter(Boolean).map((x) => proxyName(x!));
  const has = (re: RegExp) => p.some((x) => re.test(x));
  if (has(/^light|dimmer/)) return "light";
  if (has(/thermostat|hvac/)) return "thermostat";
  // A receiver that also carries an avswitch proxy is still worked like a receiver.
  if (has(/avswitch|matrix|video_?switch|hdmi_?switch/) && !has(/receiver|amplifier/)) return "switch";
  if (has(/receiver|amplifier|audio/)) return "av";
  if (has(/^tv$|television|projector/)) return "tv";
  if (has(/media|dvd|bluray|blu_ray|disc|satellite|cable|dvr|tuner/)) return "media";
  return "generic";
}

const p = (name: string, prop_type: string, extra: Partial<ParamDef> = {}): ParamDef =>
  ({ name, prop_type, default: null, readonly: false, items: [], minimum: null, maximum: null, ...extra });
const c = (name: string, description: string, ...params: ParamDef[]): CommandDef => ({ name, description, params });
const plain = (...names: string[]) => names.map((n) => c(n, `${humanize(n)} on NAME`));
const LEVEL = p("LEVEL", "RANGED_INTEGER", { minimum: "0", maximum: "100" });
const POWER = [c("ON", "Turn on NAME"), c("OFF", "Turn off NAME")];
const INPUT = c("SET_INPUT", "Select input INPUT on NAME", p("INPUT", "INTEGER"));
const VOLUME = [...plain("PULSE_VOL_UP", "PULSE_VOL_DOWN"), c("MUTE_TOGGLE", "Toggle mute on NAME")];
const NAV = plain("UP", "DOWN", "LEFT", "RIGHT", "ENTER", "CANCEL", "MENU", "INFO");
const DIGITS = plain(...Array.from({ length: 10 }, (_, i) => `NUMBER_${i}`));
const CHANNEL = plain("PULSE_CH_UP", "PULSE_CH_DOWN");
const TRANSPORT = plain("PLAY", "PAUSE", "STOP", "SCAN_REV", "SCAN_FWD", "SKIP_REV", "SKIP_FWD");

/** Control4's standard proxy commands, for a proxy whose definition lists none (Director keeps
 *  the built-in proxies' commands to itself). ponytail: a fixed list per proxy type, not the
 *  proxy definitions; the upgrade is reading them from Composer's proxy files. */
export function standardFor(proxy: string | null | undefined): CommandDef[] {
  const x = proxy ? proxyName(proxy) : "";
  if (/^light|dimmer/.test(x)) return [...POWER, c("TOGGLE", "Toggle NAME"), c("SET_LEVEL", "Set NAME level to LEVEL", LEVEL)];
  if (/avswitch/.test(x)) return [c("SET_INPUT", "Route input INPUT to output OUTPUT on NAME", p("INPUT", "INTEGER"), p("OUTPUT", "INTEGER"))];
  if (/receiver|amplifier/.test(x)) return [...POWER, INPUT, c("SET_VOLUME_LEVEL", "Set NAME volume to LEVEL", LEVEL), ...VOLUME];
  if (/^tv$|television|projector/.test(x)) return [...POWER, INPUT, ...VOLUME, ...CHANNEL, ...NAV, ...plain("GUIDE"), ...DIGITS];
  if (/satellite|cable|dvr/.test(x)) {
    return [...POWER, ...CHANNEL, ...NAV, ...plain("GUIDE", "PAGE_UP", "PAGE_DOWN", "RECALL"), ...DIGITS, ...TRANSPORT, ...plain("RECORD")];
  }
  if (/dvd|bluray|blu_ray|disc/.test(x)) return [...POWER, ...NAV, ...TRANSPORT, ...plain("EJECT")];
  if (/tuner/.test(x)) return [...POWER, ...CHANNEL];
  if (/media/.test(x)) return [...POWER, ...NAV, ...TRANSPORT];
  return [];
}

/** A command and where it goes: the device itself or one of its proxies. */
export interface Available {
  target: number;
  targetName: string;
  /** "device", or the proxy type ("light_v2"). */
  role: string;
  def: CommandDef;
  /** From the standard list, not the driver's own declaration. */
  standard: boolean;
}

/** Command names as drivers spell them: `Volume Up`, `volume-up` and `VOLUME_UP` are one name. */
export const normName = (n: string) => n.trim().toUpperCase().replace(/[\s-]+/g, "_");

/** The first of `names` that something declares — the device's own driver before a standard one. */
export function findCommand(list: Available[], ...names: string[]): Available | undefined {
  for (const n of names) {
    const hit = list.find((a) => normName(a.def.name) === n && !a.standard) ?? list.find((a) => normName(a.def.name) === n);
    if (hit) return hit;
  }
  return undefined;
}

/** The latest value of the first variable called one of `names` (upper case, as Control4
 *  spells the standard ones; "Brightness Percent" is asked for as "BRIGHTNESS PERCENT"). */
export function stateOf(vars: LiveVar[], ...names: string[]): string | null {
  for (const n of names) {
    const v = vars.find((x) => x.name.toUpperCase() === n);
    if (v) return v.value;
  }
  return null;
}

export const isOn = (v: string | null) => v != null && /^(1|on|true|yes)$/i.test(v.trim());

export function numberOf(v: string | null): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The type a parameter is sent as: what the driver declares, upper-cased; STRING if nothing. */
export const paramType = (d: ParamDef) => (d.prop_type || "STRING").toUpperCase();

/** Why a typed value can't be sent as this parameter, or null when it can. */
export function paramProblem(d: ParamDef, value: string): string | null {
  const t = paramType(d);
  if (t.includes("INTEGER") || t.includes("FLOAT") || t === "NUMBER") {
    if (value.trim() === "") return "Needs a number";
    const n = Number(value);
    if (!Number.isFinite(n)) return "Needs a number";
    if (t.includes("INTEGER") && !Number.isInteger(n)) return "Needs a whole number";
    if (d.minimum != null && n < Number(d.minimum)) return `At least ${d.minimum}`;
    if (d.maximum != null && n > Number(d.maximum)) return `At most ${d.maximum}`;
  }
  if (t === "LIST" && d.items.length && !d.items.includes(value)) return `One of ${d.items.join(", ")}`;
  return null;
}

/** A parameter's starting value: its default, the bottom of its range, or its first option. */
export function initialValue(d: ParamDef): string {
  return d.default ?? (d.items[0] ?? d.minimum ?? "");
}

/** "PULSE_VOL_UP" → "Pulse vol up": a driver command's name as a button label. */
export function humanize(name: string): string {
  const s = name.replace(/_/g, " ").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The parameters to send with a command: each declared one filled by the first rule whose
 *  pattern matches its name, else its default. A command declaring none (a standard one, or a
 *  driver that leaves them out) gets `fallback`, which is what Control4's proxies expect. */
export function fillParams(def: CommandDef, rules: [RegExp, (p: ParamDef) => string][], fallback: CommandParam[] = []): CommandParam[] {
  if (!def.params.length) return fallback;
  return def.params.map((x) => {
    const rule = rules.find(([re]) => re.test(x.name));
    return { name: x.name, type: paramType(x), value: rule ? rule[1](x) : initialValue(x) || "0" };
  });
}

// ---- light colour ------------------------------------------------------------------------------
// Control4's light_v2 speaks CIE 1931 xy (plus a mode: 0 full colour, 1 colour temperature);
// people pick colours on an sRGB wheel. Everything below converts between the two.

export type Rgb = [number, number, number];

/** Hue in degrees, saturation and value 0–1. */
export function hsvToRgb(h: number, s: number, v = 1): Rgb {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

export function rgbToHsv([r, g, b]: Rgb): { h: number; s: number; v: number } {
  const v = Math.max(r, g, b), d = v - Math.min(r, g, b);
  let h = 0;
  if (d) h = v === r ? ((g - b) / d) % 6 : v === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: v ? d / v : 0, v };
}

const toLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const toGamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

/** sRGB (0–1) to CIE xy, D65. Black has no chromaticity; it comes back as the white point. */
export function rgbToXy([r, g, b]: Rgb): [number, number] {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const X = 0.4124 * R + 0.3576 * G + 0.1805 * B;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = 0.0193 * R + 0.1192 * G + 0.9505 * B;
  const sum = X + Y + Z;
  return sum ? [X / sum, Y / sum] : [0.3127, 0.329];
}

/** CIE xy to the brightest sRGB colour of that chromaticity (out-of-gamut parts clipped). */
export function xyToRgb(x: number, y: number): Rgb {
  if (y <= 0) return [1, 1, 1];
  const X = x / y, Y = 1, Z = (1 - x - y) / y;
  const lin = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z].map((n) => Math.max(0, n));
  const m = Math.max(...lin) || 1;
  return lin.map((n) => Math.min(1, toGamma(n / m))) as Rgb;
}

/** A colour temperature's point on the Planckian locus (Kim et al.'s cubic fit, 1667–25000 K). */
export function kelvinToXy(k: number): [number, number] {
  const t = Math.max(1667, Math.min(25000, k));
  const x = t <= 4000
    ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
    : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y = t <= 2222
    ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
    : t <= 4000
      ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

/** The nearest colour temperature to a chromaticity (McCamy's approximation). */
export function xyToKelvin(x: number, y: number): number {
  const n = (x - 0.332) / (0.1858 - y);
  return Math.round(449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33);
}

export const cssRgb = ([r, g, b]: Rgb) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

export interface LightState {
  on: boolean | null;
  /** Brightness, 0–100. */
  level: number | null;
  /** Hue (degrees) and saturation (0–1) of the colour it shows, when it reports one. */
  hs: { h: number; s: number } | null;
  kelvin: number | null;
  /** Which way it was last set: a full colour or a colour temperature. */
  mode: "color" | "cct" | null;
}

/** A light_v2's state from its variables. Drivers name them differently (the Hue driver's
 *  "Brightness Percent", "Current Color Hue", "Current Color Chromaticity" = "x,y,mode";
 *  Control4's own LIGHT_LEVEL), so each is looked for under a few names. */
export function lightStateOf(vars: LiveVar[]): LightState {
  const level = numberOf(stateOf(vars, "BRIGHTNESS PERCENT", "LIGHT_LEVEL", "LEVEL", "BRIGHTNESS", "LIGHT_BRIGHTNESS_CURRENT"));
  const power = stateOf(vars, "LIGHT_STATE", "POWER_STATE", "STATE");
  const on = power != null ? isOn(power) : level != null ? level > 0 : null;
  let xy: number[] | null = null;
  const chroma = stateOf(vars, "CURRENT COLOR CHROMATICITY", "LIGHT_COLOR_CURRENT", "COLOR_XY");
  if (chroma) xy = chroma.split(/[,;\s]+/).map(Number).filter(Number.isFinite);
  const cx = numberOf(stateOf(vars, "LIGHT_COLOR_CURRENT_X", "CURRENT COLOR X")), cy = numberOf(stateOf(vars, "LIGHT_COLOR_CURRENT_Y", "CURRENT COLOR Y"));
  if ((!xy || xy.length < 2) && cx != null && cy != null) xy = [cx, cy, numberOf(stateOf(vars, "LIGHT_COLOR_CURRENT_MODE")) ?? NaN];
  const modeNum = xy && xy.length > 2 && Number.isFinite(xy[2]) ? xy[2] : null;
  const mode = modeNum == null ? null : modeNum === 1 ? "cct" : "color";

  const hue = numberOf(stateOf(vars, "CURRENT COLOR HUE", "LIGHT_COLOR_CURRENT_HUE", "COLOR_HUE", "HUE"));
  const sat = numberOf(stateOf(vars, "CURRENT COLOR SATURATION", "LIGHT_COLOR_CURRENT_SATURATION", "COLOR_SATURATION", "SATURATION"));
  let hs: LightState["hs"] = null;
  if (hue != null && sat != null) hs = { h: ((hue % 360) + 360) % 360, s: Math.max(0, Math.min(1, sat > 1 ? sat / 100 : sat)) };
  else if (xy && xy.length >= 2 && xy[1] > 0) {
    const { h, s } = rgbToHsv(xyToRgb(xy[0], xy[1]));
    hs = { h, s };
  }
  let kelvin = numberOf(stateOf(vars, "CURRENT CCT", "LIGHT_COLOR_CURRENT_CCT", "COLOR_TEMPERATURE", "CCT", "KELVIN"));
  if (kelvin == null && mode === "cct" && xy) kelvin = xyToKelvin(xy[0], xy[1]);
  return { on, level, hs, kelvin, mode };
}

// ---- matrix switching --------------------------------------------------------------------------

/** One input or output of a matrix, as its grid shows it and as its routing command sends it. */
export interface Port {
  key: string;
  label: string;
  /** What it's wired to, when anything is. */
  detail: string;
  /** What the command is sent: the binding id, or the driver's own option. */
  value: string;
}

const AV = /HDMI|VIDEO|COMPONENT|COMPOSITE|DVI|HDBASET|SDI/;
const AUDIO = /AUDIO|STEREO|DIGITAL|COAX|OPTICAL|SPDIF/;

/** A matrix's inputs or outputs: the routing command's own options when it lists them, else
 *  the device's connections in that direction — video ones, or audio when there is no video. */
export function matrixPorts(param: ParamDef | undefined, connections: ConnectionDef[], role: "input" | "output"): Port[] {
  if (param?.items.length) return param.items.map((o) => ({ key: o, label: o, detail: "", value: o }));
  const mine = connections.filter((x) => x.role === role);
  const video = mine.filter((x) => x.classes.some((k) => AV.test(k)));
  const pick = video.length ? video : mine.filter((x) => x.classes.some((k) => AUDIO.test(k)));
  const seen = new Set<number>();
  return pick
    .filter((x) => !seen.has(x.id) && seen.add(x.id))
    .sort((a, b) => a.id - b.id)
    .map((x) => ({
      key: String(x.id), label: x.name, value: String(x.id),
      detail: x.connected_to.map((pe) => pe.device.name).filter(Boolean).join(", "),
    }));
}

/** The command a matrix routes with, and which of its parameters is the input and the output. */
export function routeCommand(list: Available[]): { a: Available; input: ParamDef | undefined; output: ParamDef | undefined } | null {
  const io = (a: Available) => ({
    input: a.def.params.find((x) => /INPUT|SOURCE/i.test(x.name) && !/OUTPUT/i.test(x.name)),
    output: a.def.params.find((x) => /OUTPUT|ZONE|DEST/i.test(x.name)),
  });
  const named = findCommand(list, "SET_INPUT", "ROUTE", "SET_ROUTE", "SWITCH", "SET_OUTPUT_INPUT");
  if (named && (io(named).output || !named.def.params.length)) return { a: named, ...io(named) };
  const any = list.find((a) => !a.standard && io(a).input && io(a).output);
  return any ? { a: any, ...io(any) } : null;
}

/** Which input each output shows, from whatever variables the driver keeps for it
 *  ("OUTPUT_1_SOURCE" = "3", "Output 2 Input" = "Apple TV"…). Keys are Port keys. */
export function routesFrom(vars: LiveVar[], inputs: Port[], outputs: Port[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of vars) {
    const m = /OUT(?:PUT)?[\s_#-]*(\d+)/i.exec(v.name);
    if (!m || !/IN(?:PUT)?\b|IN(?:PUT)?_|SOURCE|ROUTE|SELECT/i.test(v.name.replace(m[0], ""))) continue;
    const o = outputs[Number(m[1]) - 1] ?? outputs.find((x) => x.value === m[1]);
    const val = v.value.trim();
    if (!o || !val) continue;
    const n = Number(val);
    const i = inputs.find((x) => x.value === val)
      ?? inputs.find((x) => x.label.toLowerCase() === val.toLowerCase())
      ?? (Number.isInteger(n) && n >= 1 ? inputs[n - 1] : undefined);
    if (i) out.set(o.key, i.key);
  }
  return out;
}
