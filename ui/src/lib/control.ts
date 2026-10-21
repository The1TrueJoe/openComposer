/** Device control without the UI: reading a device's live variables, telling what kind of
 *  device it is, finding the commands its remote sends, and the arithmetic behind the remotes
 *  (light colours, matrix routes). No components here (pages/design/DeviceControl.tsx draws
 *  the panel). */

import type { CommandDef, CommandParam, ConnectionDef, ConnectionRow, ItemDetail, ParamDef, ShortItem, TreeNode } from "../api/types.ts";

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
const LEVEL = p("LEVEL", "RANGED_INTEGER", { minimum: "0", maximum: "100" });

/** A command and where it goes: the device itself or one of its proxies. */
export interface Available {
  target: number;
  targetName: string;
  /** "device", or the proxy type ("light_v2"). */
  role: string;
  def: CommandDef;
  /** null when the driver (or its proxy) declares the command. Otherwise what shows the device
   *  takes it although nothing declares it by name: "capability has_discrete_volume_control",
   *  "variable POWER_STATE", "programming"… */
  evidence: string | null;
  /** Declared, but the device's own capabilities or variables say it doesn't do it (a TV whose
   *  proxy lists bass controls it hasn't got). Kept for All commands; no button on the remote. */
  unsupported?: string;
}

/** Command names as drivers spell them: `Volume Up`, `volume-up` and `VOLUME_UP` are one name. */
export const normName = (n: string) => n.trim().toUpperCase().replace(/[\s-]+/g, "_");

/** Capabilities as declared, keys lower-cased; older backends don't send them at all. */
export function capsOf(x: ItemDetail): Record<string, string> {
  const own = (x as { capabilities?: Record<string, string> | null }).capabilities;
  const all = { ...(x.device?.capabilities ?? {}), ...(own ?? {}) };
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

export const truthy = (v: string | null | undefined) => v != null && /^(true|1|yes)$/i.test(v.trim());

/** Control4's built-in proxies (tv.c4i…) list their commands by template only: `GetItems`
 *  gives "Turn on the NAME" with no name. These are the ones whose name is Control4's proxy
 *  command of that wording; anything else stays unnamed and is left out (it can't be sent). */
const TEMPLATE_NAMES: [RegExp, string][] = [
  [/^turn on\b/i, "ON"], [/^turn off\b/i, "OFF"],
  [/^push the (menu|up|down|left|right|enter|cancel|info|recall|dash|star|pound|guide|exit|home|back)\b/i, "$1"],
  [/^push the tvvideo\b/i, "TV_VIDEO"],
  [/^enter '(\d)'/i, "NUMBER_$1"],
  [/^(pulse|start|stop) the (volume|channel|bass|treble|balance) (up|down)\b/i, "$1_$2_$3"],
  [/^turn mute (on|off|toggle)\b/i, "MUTE_$1"],
  [/^set volume to\b/i, "SET_VOLUME_LEVEL"], [/^set channel to\b/i, "SET_CHANNEL"], [/^set input to\b/i, "SET_INPUT"],
  [/^set (bass|treble|balance) to\b/i, "SET_$1_LEVEL"],
  [/^pulse the input\b/i, "PULSE_INPUT"],
];
const SHORT: Record<string, string> = { VOLUME: "VOL", CHANNEL: "CH" };
/** Parameters the templated "Set … to INTEGER" commands take (the template says INTEGER, the
 *  proxy definition gives no name). */
const TEMPLATE_PARAMS: Record<string, ParamDef[]> = {
  SET_VOLUME_LEVEL: [LEVEL], SET_CHANNEL: [p("CHANNEL", "INTEGER")], SET_INPUT: [p("INPUT", "INTEGER")],
  SET_BASS_LEVEL: [p("LEVEL", "INTEGER")], SET_TREBLE_LEVEL: [p("LEVEL", "INTEGER")], SET_BALANCE_LEVEL: [p("LEVEL", "INTEGER")],
};

function nameFromTemplate(def: CommandDef): CommandDef | null {
  if (def.name.trim()) return def;
  const t = def.description.trim();
  for (const [re, to] of TEMPLATE_NAMES) {
    const m = re.exec(t);
    if (!m) continue;
    const name = to.replace(/\$(\d)/g, (_, i) => { const w = m[Number(i)].toUpperCase(); return SHORT[w] ?? w; });
    return { ...def, name, params: def.params.length ? def.params : TEMPLATE_PARAMS[name] ?? [] };
  }
  return null;
}

/** Which capability a kind of command needs (any of the keys will do), for the AV proxies that
 *  describe themselves with `has_…` capabilities. Navigation and power have none. */
const GATES: [RegExp, string[]][] = [
  [/^(PULSE|START|STOP)_VOL_(UP|DOWN)$/, ["has_up_down_volume_control"]],
  [/^SET_VOLUME_LEVEL$/, ["has_discrete_volume_control"]],
  [/^MUTE_TOGGLE$/, ["has_toggle_mute_control"]],
  [/^MUTE_(ON|OFF)$/, ["has_discrete_mute_control"]],
  [/^(PULSE|START|STOP)_CH_(UP|DOWN)$/, ["has_channel_up_down", "has_tune_up_down"]],
  [/^SET_CHANNEL$/, ["has_discrete_channel_select"]],
  [/^(PULSE_INPUT|INPUT_TOGGLE)$/, ["has_toad_input_select"]],
  [/^(PULSE|START|STOP)_BASS_(UP|DOWN)$/, ["has_up_down_bass_control"]], [/^SET_BASS_LEVEL$/, ["has_discrete_bass_control"]],
  [/^(PULSE|START|STOP)_TREBLE_(UP|DOWN)$/, ["has_up_down_treble_control"]], [/^SET_TREBLE_LEVEL$/, ["has_discrete_treble_control"]],
  [/^(PULSE|START|STOP)_BALANCE_(UP|DOWN)$/, ["has_up_down_balance_control"]], [/^SET_BALANCE_LEVEL$/, ["has_discrete_balance_control"]],
];
/** Proxies whose capabilities speak that vocabulary (a media player's don't). */
const GATED_PROXY = /^(tv|receiver|avswitch|amplifier|projector|tuner)/;
const CHANNEL_PROXY = /^(tv|tuner|satellite|cable|dvr)/;
const AUDIO_PROXY = /^(tv|receiver|amplifier|projector)/;
const INPUT_PROXY = /^(tv|receiver|amplifier|projector)/;
const LIGHT_PROXY = /^light|dimmer/;
const DIGIT_KEYS = /^(NUMBER_\d|DASH|STAR|POUND)$/;
const DPAD_KEYS = /^(UP|DOWN|LEFT|RIGHT|ENTER)$/;
const TRANSPORT = new Set(["PLAY", "PAUSE", "STOP", "SCAN_FWD", "SCAN_REV", "SKIP_FWD", "SKIP_REV", "RECORD"]);
/** Keys Navigator shows only when TRANSPORTS_BUTTONS lists them. */
const MENU_KEYS = new Set(["MENU", "INFO", "GUIDE", "CANCEL", "HOME", "BACK", "EXIT", "CC", "SETTINGS"]);
/** TRANSPORTS_SUPPORTED's groups of keys, and the commands each stands for. */
const GROUP_COMMANDS: Record<string, string[]> = {
  PG_UP: ["PAGE_UP"], PG_DOWN: ["PAGE_DOWN"], PRG_BTNS: ["PROGRAM_A", "PROGRAM_B", "PROGRAM_C", "PROGRAM_D"],
};

/** What a media device's TRANSPORTS_* variables say it has — what Navigator draws its remote
 *  from: transport keys, and key groups (DPAD, KEYPAD, CH_UP_DN, PG_UP, PRG_BTNS) in
 *  TRANSPORTS_SUPPORTED; extra keys (HOME, BACK, MENU, INFO…) in TRANSPORTS_BUTTONS. Null when
 *  the device doesn't say. */
function navigatorOf(vars: LiveVar[], owner: number): { supported: Set<string> | null; buttons: Set<string> | null } {
  const mine = vars.filter((v) => v.owner === owner);
  const list = (...names: string[]) => {
    const found = names.map((n) => mine.find((v) => v.name.toUpperCase() === n)).filter((v): v is LiveVar => !!v);
    if (!found.length) return null;
    return new Set(found.flatMap((v) => v.value.split(/[,;\s]+/)).map(normName).filter(Boolean)
      .flatMap((x) => (x === "SCAN" ? ["SCAN_FWD", "SCAN_REV"] : x === "SKIP" ? ["SKIP_FWD", "SKIP_REV"] : [x])));
  };
  const supported = list("TRANSPORTS_SUPPORTED", "TRANSPORTS_DASHBOARD_SMALL", "TRANSPORTS_DASHBOARD_LARGE");
  return { supported: supported?.size ? supported : null, buttons: list("TRANSPORTS_BUTTONS") };
}

/** Why the device doesn't take a command it (or its proxy type) declares, if it doesn't. */
function ruledOut(n: string, role: string, caps: Record<string, string>, nav: ReturnType<typeof navigatorOf>): string | undefined {
  const gate = GATED_PROXY.test(role) && Object.keys(caps).some((k) => k.startsWith("has_")) ? GATES.find(([re]) => re.test(n)) : undefined;
  if (gate && !gate[1].some((k) => truthy(caps[k]))) return `${gate[1][0]} is ${caps[gate[1][0]] ?? "not declared"}`;
  const s = nav.supported;
  if (s) {
    if (TRANSPORT.has(n) && !s.has(n)) return "not in its TRANSPORTS_SUPPORTED";
    if (DPAD_KEYS.test(n) && !s.has("DPAD")) return "no DPAD in its TRANSPORTS_SUPPORTED";
    if (DIGIT_KEYS.test(n) && !s.has("KEYPAD")) return "no KEYPAD in its TRANSPORTS_SUPPORTED";
    if (/^(PULSE|START|STOP)_CH_(UP|DOWN)$/.test(n) && !s.has("CH_UP_DN")) return "no CH_UP_DN in its TRANSPORTS_SUPPORTED";
    for (const [group, cmds] of Object.entries(GROUP_COMMANDS)) if (cmds.includes(n) && !s.has(group)) return `no ${group} in its TRANSPORTS_SUPPORTED`;
  } else if (DIGIT_KEYS.test(n) && CHANNEL_PROXY.test(role) && GATED_PROXY.test(role) && Object.keys(caps).some((k) => k.startsWith("has_"))
    && !truthy(caps.has_discrete_channel_select)) {
    return "has_discrete_channel_select is not declared";
  }
  if (nav.buttons && MENU_KEYS.has(n) && !nav.buttons.has(n)) return "not in its TRANSPORTS_BUTTONS";
  return undefined;
}

/** A command programming already sends to the item: proof it takes it, with its parameters. */
export interface ProgrammedCommand { target: number; command: string; params: { name: string; type: string; value: string }[] }

/** Commands a proxy that names none still shows it takes. Each is something the device says
 *  about itself; nothing is assumed from its proxy type alone. Capabilities are the device's,
 *  shared by all its proxies, so each kind is only read for the proxies it is about. */
function evidenced(x: ItemDetail, role: string, caps: Record<string, string>, vars: LiveVar[]): [CommandDef, string][] {
  const out: [CommandDef, string][] = [];
  const cap = (k: string, ...defs: CommandDef[]) => { if (truthy(caps[k])) defs.forEach((d) => out.push([d, `capability ${k}`])); };
  if (/^avswitch/.test(role)) cap("can_switch", c("SET_INPUT", "Route input INPUT to output OUTPUT on NAME", p("INPUT", "INTEGER"), p("OUTPUT", "INTEGER")));
  if (INPUT_PROXY.test(role)) cap("has_discrete_input_select", c("SET_INPUT", "Select input INPUT on NAME", p("INPUT", "INTEGER")));
  if (AUDIO_PROXY.test(role)) {
    cap("has_up_down_volume_control", c("PULSE_VOL_UP", "Volume up on NAME"), c("PULSE_VOL_DOWN", "Volume down on NAME"));
    cap("has_discrete_volume_control", c("SET_VOLUME_LEVEL", "Set NAME volume to LEVEL", LEVEL));
    cap("has_toggle_mute_control", c("MUTE_TOGGLE", "Toggle mute on NAME"));
    cap("has_discrete_mute_control", c("MUTE_ON", "Mute NAME"), c("MUTE_OFF", "Unmute NAME"));
  }
  if (CHANNEL_PROXY.test(role)) {
    cap("has_channel_up_down", c("PULSE_CH_UP", "Channel up on NAME"), c("PULSE_CH_DOWN", "Channel down on NAME"));
    cap("has_discrete_channel_select", c("SET_CHANNEL", "Set NAME channel to CHANNEL", p("CHANNEL", "INTEGER")));
  }
  if (LIGHT_PROXY.test(role)) {
    cap("on_off", c("ON", "Turn on NAME"), c("OFF", "Turn off NAME"));
    if (truthy(caps.dimmer) || truthy(caps.set_level)) out.push([c("SET_LEVEL", "Set NAME level to LEVEL", LEVEL), `capability ${truthy(caps.set_level) ? "set_level" : "dimmer"}`]);
  }
  // A proxy that reports its power takes power commands.
  const power = vars.find((v) => v.owner === x.id && /^(POWER_STATE|LIGHT_STATE)$/i.test(v.name));
  if (power) out.push([c("ON", "Turn on NAME"), `variable ${power.name}`], [c("OFF", "Turn off NAME"), `variable ${power.name}`]);
  return out;
}

/** Everything the device and its proxies can be sent, and which of it the remote may draw:
 *  commands declared by name (or by a built-in proxy's template), less those its capabilities
 *  or TRANSPORTS_* variables rule out; for a proxy that declares none, only what the device
 *  shows about itself — capabilities, variables, programming that already sends it. Shared by
 *  the control panel and Programming's command list. */
export function commandsOf(items: ItemDetail[], vars: LiveVar[] = [], programmed: ProgrammedCommand[] = []): Available[] {
  return items.flatMap((x, i) => {
    const role = i === 0 && x.kind !== "proxy" ? "device" : (x.driver ?? "proxy").toLowerCase().replace(/\.c4[iz]$/, "");
    const caps = capsOf(x);
    const nav = navigatorOf(vars, x.id);
    const out: Available[] = [];
    const seen = new Set<string>();
    const push = (def: CommandDef, evidence: string | null) => {
      const n = normName(def.name);
      if (!n || seen.has(n)) return;
      seen.add(n);
      out.push({ target: x.id, targetName: x.name, role, def, evidence, unsupported: ruledOut(n, role, caps, nav) });
    };
    const own = (x.commands ?? []).map(nameFromTemplate).filter((d): d is CommandDef => !!d);
    own.forEach((d) => push(d, null));
    // What the device says Navigator should show, whatever its proxy declares.
    for (const t of nav.supported ?? []) {
      if (TRANSPORT.has(t)) push(c(t, `${humanize(t)} on NAME`), "variable TRANSPORTS_SUPPORTED");
      for (const cmd of GROUP_COMMANDS[t] ?? []) push(c(cmd, `${humanize(cmd)} on NAME`), "variable TRANSPORTS_SUPPORTED");
    }
    for (const b of nav.buttons ?? []) push(c(b, `${humanize(b)} on NAME`), "variable TRANSPORTS_BUTTONS");
    if (!own.length && (i > 0 || x.kind === "proxy")) evidenced(x, role, caps, vars).forEach(([d, why]) => push(d, why));
    for (const l of programmed.filter((l) => l.target === x.id && l.command)) {
      push(c(l.command, `${humanize(l.command)} on NAME`, ...l.params.map((q) => p(q.name, q.type || "STRING", { default: q.value }))), "programming");
    }
    return out;
  });
}

/** The first of `names` the device takes — one it declares before one only evidenced. */
export function findCommand(list: Available[], ...names: string[]): Available | undefined {
  const ok = list.filter((a) => !a.unsupported);
  for (const n of names) {
    const hit = ok.find((a) => normName(a.def.name) === n && !a.evidence) ?? ok.find((a) => normName(a.def.name) === n);
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
 *  pattern matches its name, else its default. A command declaring none (one known only from
 *  the device's capabilities, or a driver that leaves them out) gets `fallback`, which is what
 *  Control4's proxies expect. */
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
  const any = list.find((a) => !a.unsupported && !a.evidence && io(a).input && io(a).output);
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

// ---- rooms ---------------------------------------------------------------------------------------

/** What a room (Director's roomdevice) is sent: picking what to watch or listen to, room off and
 *  the room's volume, which Director passes to whichever device is playing. The room driver
 *  declares none of them (`GetItems` lists no commands for a room), so they are listed here.
 *  ponytail: a fixed list — each one sent to the Virtual Director's Living Room and accepted;
 *  SELECT_*, ROOM_OFF and MUTE_ON/OFF were seen changing the room's variables. Others Director
 *  takes (transport, navigation for the selected source) are left out until checked the same way. */
export const ROOM_COMMANDS: CommandDef[] = [
  c("ROOM_OFF", "Turn off NAME"),
  c("SELECT_VIDEO_DEVICE", "Watch a source in NAME", p("deviceid", "INTEGER")),
  c("SELECT_AUDIO_DEVICE", "Listen to a source in NAME", p("deviceid", "INTEGER")),
  c("SET_VOLUME_LEVEL", "Set NAME volume to LEVEL", LEVEL),
  c("PULSE_VOL_UP", "Volume up in NAME"), c("PULSE_VOL_DOWN", "Volume down in NAME"),
  c("MUTE_TOGGLE", "Toggle mute in NAME"), c("MUTE_ON", "Mute NAME"), c("MUTE_OFF", "Unmute NAME"),
];

/** A room's commands: its own, Director's room commands, and any programming already sends it. */
export function roomCommands(room: ItemDetail, programmed: ProgrammedCommand[] = []): Available[] {
  // What the room driver declares wins; then Director's list; then anything else programming sends it.
  const own = commandsOf([room], [], programmed).map((a) => ({ ...a, role: "room" }));
  const declared = new Set(own.filter((a) => !a.evidence).map((a) => normName(a.def.name)));
  const known = new Set(ROOM_COMMANDS.map((d) => d.name));
  return [
    ...own.filter((a) => !a.evidence),
    ...ROOM_COMMANDS.filter((d) => !declared.has(d.name)).map((def) => ({ target: room.id, targetName: room.name, role: "room", def, evidence: "Director's room commands" })),
    ...own.filter((a) => a.evidence && !known.has(normName(a.def.name))),
  ];
}

export interface RoomSource {
  id: number;
  name: string;
  driver: string | null;
  /** The devices between it and the room, nearest the source first ("Leaf 8x8 HDMI Matrix"). */
  via: string[];
}

const VIDEO_CLASS = /HDMI|VIDEO|COMPONENT|COMPOSITE|DVI|HDBASET|SDI/;
const AUDIO_CLASS = /STEREO|DIGITAL|COAX|OPTICAL|SPDIF|AUDIO/;
const NOT_MEDIA = /_SELECTION|_VOLUME|IR_|RS_?232|CONTROL|TEMPERATURE|SECURITY/;
/** Proxies that pass a picture or sound on rather than make it: walked through, not offered. */
const PASS_THROUGH = /^(avswitch|receiver|amplifier|tv|projector|display|audio_?matrix)/;

/** What a room can watch and listen to, as Director works it out: from the room's video and
 *  audio end-points (its VIDEO_SELECTION / AUDIO_SELECTION connections), back along the AV
 *  bindings through switches and receivers to the devices that make the picture or sound.
 *  `rows` is every connection in the project (list_connections); `tree` the project tree, for
 *  drivers whose AV connections sit on the device rather than on its proxy. */
export function roomSources(room: ItemDetail, rows: ConnectionRow[], tree?: TreeNode | null): {
  watch: RoomSource[]; listen: RoomSource[]; endpoints: { watch: ShortItem[]; listen: ShortItem[] };
} {
  const info = new Map<number, ShortItem>();
  const parent = new Map<number, number>();
  const proxies = new Map<number, TreeNode[]>();
  const index = (n: TreeNode) => {
    info.set(n.id, { id: n.id, name: n.name, kind: n.kind, driver: n.driver });
    // A device's only proxy is folded into it in the tree; its driver comes from the rows.
    if (n.proxy) {
      parent.set(n.proxy, n.id);
      proxies.set(n.id, [{ id: n.proxy, name: n.name, kind: "proxy", driver: null, children: [] }]);
    }
    for (const ch of n.children) {
      if (ch.kind === "proxy") {
        parent.set(ch.id, n.id);
        proxies.set(n.id, [...(proxies.get(n.id) ?? []), ch]);
      }
      index(ch);
    }
  };
  if (tree) index(tree);
  const inputs = new Map<number, { from: number; classes: string[] }[]>();
  for (const r of rows) {
    if (!info.has(r.device.id)) info.set(r.device.id, { id: r.device.id, name: r.device.name });
    for (const peer of r.connection.connected_to) {
      info.set(peer.device.id, { ...info.get(peer.device.id), ...peer.device });
      const classes = peer.classes.length ? peer.classes : r.connection.classes;
      if (r.connection.role !== "input" || classes.every((k) => NOT_MEDIA.test(k))) continue;
      const list = inputs.get(r.device.id) ?? [];
      // One edge per pair, with every class between them (a player wired by stereo and HDMI).
      const had = list.find((e) => e.from === peer.device.id);
      if (had) had.classes = [...new Set([...had.classes, ...classes])];
      else list.push({ from: peer.device.id, classes });
      inputs.set(r.device.id, list);
    }
  }
  const proxyType = (driver: string | null | undefined) => (driver ?? "").toLowerCase().replace(/\.c4[iz]$/, "");
  // A device and its proxies are one box: its inputs may be declared on either.
  const inputsOf = (id: number) => {
    const p = parent.get(id);
    return [...(inputs.get(id) ?? []), ...(p != null ? inputs.get(p) ?? [] : []), ...(proxies.get(id) ?? []).flatMap((x) => inputs.get(x.id) ?? [])];
  };
  /** What to select for a device that is a source: its first proxy that makes media. */
  const selectable = (id: number): ShortItem | null => {
    const it = info.get(id) ?? { id, name: `#${id}` };
    if (it.kind === "room") return null;
    const kids = proxies.get(id);
    if (it.kind === "device" && kids?.length) {
      const own = kids.map((k) => info.get(k.id) ?? k).find((k) => !PASS_THROUGH.test(proxyType(k.driver)));
      return own ? { id: own.id, name: own.name, kind: "proxy", driver: own.driver ?? null } : null;
    }
    return PASS_THROUGH.test(proxyType(it.driver)) ? null : it;
  };

  // The room's end-points, from its own connections and from the other side's (a backend that
  // hides some of the room's connections still lists the devices bound to it).
  const ends = (selection: string, skip?: RegExp) => [...new Map([
    ...room.connections
      .filter((x) => x.classes.includes(selection) && !(skip && skip.test(x.name)))
      .flatMap((x) => x.connected_to.map((peer) => [peer.device.id, peer.device] as const)),
    ...rows.flatMap((r) => r.connection.connected_to
      .filter((peer) => peer.device.id === room.id && peer.classes.includes(selection) && !(skip && skip.test(peer.connection ?? "")))
      .map(() => [r.device.id, info.get(r.device.id) ?? { id: r.device.id, name: r.device.name }] as const)),
  ]).values()];
  const walk = (from: ShortItem[], media: RegExp): RoomSource[] => {
    const found = new Map<number, RoomSource>();
    const seen = new Set<number>(from.flatMap((e) => [e.id, parent.get(e.id) ?? e.id]));
    const queue: { id: number; via: string[] }[] = from.map((e) => ({ id: e.id, via: [] }));
    while (queue.length) {
      const at = queue.shift()!;
      for (const e of inputsOf(at.id)) {
        if (seen.has(e.from) || !e.classes.some((k) => media.test(k) && !NOT_MEDIA.test(k))) continue;
        seen.add(e.from);
        const it = info.get(e.from) ?? { id: e.from, name: `#${e.from}` };
        const pick = selectable(e.from);
        if (pick && !found.has(pick.id)) found.set(pick.id, { id: pick.id, name: pick.name, driver: pick.driver ?? null, via: at.via });
        queue.push({ id: e.from, via: [it.name, ...at.via] });
      }
    }
    return [...found.values()].sort((a, b) => a.via.length - b.via.length || a.name.localeCompare(b.name));
  };
  const watchEnds = ends("VIDEO_SELECTION");
  // "Video's Audio End-Point" is where a picture's sound plays, not something to listen to.
  const listenEnds = ends("AUDIO_SELECTION", /video/i);
  return {
    watch: walk(watchEnds, VIDEO_CLASS),
    listen: walk(listenEnds, new RegExp(`${AUDIO_CLASS.source}|${VIDEO_CLASS.source}`)),
    endpoints: { watch: watchEnds, listen: listenEnds },
  };
}
