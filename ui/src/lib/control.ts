/** Device control without the UI: reading a device's live variables, telling what kind of
 *  device it is, and finding the commands its quick controls send. No components here
 *  (pages/design/DeviceControl.tsx draws the panel). */

import type { CommandDef, ParamDef } from "../api/types.ts";

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

/** What a device is, for its quick controls: Control4's proxy families. */
export type Family = "light" | "av" | "tv" | "media" | "thermostat" | "generic";

export function familyOf(proxies: (string | null | undefined)[]): Family {
  const p = proxies.filter(Boolean).map((x) => x!.toLowerCase().replace(/\.c4[iz]$/, ""));
  const has = (re: RegExp) => p.some((x) => re.test(x));
  if (has(/^light|dimmer/)) return "light";
  if (has(/thermostat|hvac/)) return "thermostat";
  if (has(/receiver|avswitch|amplifier|audio/)) return "av";
  if (has(/^tv$|television|projector/)) return "tv";
  if (has(/media|dvd|bluray|satellite|cable|tuner/)) return "media";
  return "generic";
}

const p = (name: string, prop_type: string, extra: Partial<ParamDef> = {}): ParamDef =>
  ({ name, prop_type, default: null, readonly: false, items: [], minimum: null, maximum: null, ...extra });
const c = (name: string, description: string, ...params: ParamDef[]): CommandDef => ({ name, description, params });
const LEVEL = p("LEVEL", "RANGED_INTEGER", { minimum: "0", maximum: "100" });
const POWER = [c("ON", "Turn on NAME"), c("OFF", "Turn off NAME")];

/** Control4's standard proxy commands, for a proxy whose definition lists none (Director keeps
 *  the built-in proxies' commands to itself). ponytail: a fixed list per family, not the proxy
 *  definitions; the upgrade is reading them from Composer's proxy files. */
export const STANDARD: Record<Family, CommandDef[]> = {
  light: [...POWER, c("TOGGLE", "Toggle NAME"), c("SET_LEVEL", "Set NAME level to LEVEL", LEVEL)],
  av: [...POWER, c("SET_VOLUME_LEVEL", "Set NAME volume to LEVEL", LEVEL), c("PULSE_VOL_UP", "Volume up on NAME"),
    c("PULSE_VOL_DOWN", "Volume down on NAME"), c("MUTE_TOGGLE", "Toggle mute on NAME")],
  tv: [...POWER],
  media: [...POWER, c("PLAY", "Play on NAME"), c("PAUSE", "Pause NAME"), c("STOP", "Stop NAME")],
  thermostat: [],
  generic: [],
};

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

/** The first of `names` that something declares — the device's own driver before a standard one. */
export function findCommand(list: Available[], ...names: string[]): Available | undefined {
  for (const n of names) {
    const hit = list.find((a) => a.def.name === n && !a.standard) ?? list.find((a) => a.def.name === n);
    if (hit) return hit;
  }
  return undefined;
}

/** The latest value of the first variable called one of `names`. */
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
