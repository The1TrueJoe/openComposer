/** Driver files from three places — the controller, the library on this computer, Control4's
 *  online database — as one kind of row, so the Add devices pane can search them together and
 *  say where each one can come from. No components here. */

import type { ControllerDriver, DriverDoc, LibraryDriver } from "../../api";

/** Where a driver file can be had, best first: already installed, on this computer, or in
 *  Control4's database (downloaded when it's added). */
export type Where = "controller" | "library" | "online";

export interface DriverRow {
  filename: string;
  name: string;
  manufacturer: string;
  model: string;
  version: string | null;
  control_method: string;
  proxies: string[];
  search_types: string[];
  certified: boolean;
  where: Where[];
  /** The library copy, when there is one: says whether it's ours or Composer's. */
  library: LibraryDriver | null;
  /** The controller's own category for it, when it gives one. */
  category: string | null;
  primary_proxy: string | null;
}

const key = (filename: string) => filename.toLowerCase();

/** Some firmware lists proxies as objects; only their names matter here. */
function names(list: unknown[] | undefined): string[] {
  return (list ?? []).flatMap((p) => {
    if (typeof p === "string") return [p];
    const n = p && typeof p === "object" ? (p as Record<string, unknown>).name ?? (p as Record<string, unknown>).filename : null;
    return typeof n === "string" ? [n] : [];
  });
}

export function fromController(d: ControllerDriver): DriverRow {
  return {
    filename: d.filename, name: d.name || d.filename, manufacturer: d.manufacturer ?? "", model: d.model ?? "",
    version: d.version == null || d.version === "" ? null : String(d.version), control_method: "",
    proxies: names(d.proxies), search_types: d.searchTypes ?? [], certified: !!d.certified, where: ["controller"], library: null,
    category: d.category ?? null, primary_proxy: d.primaryProxy || null,
  };
}

export function fromLibrary(d: LibraryDriver): DriverRow {
  return {
    filename: d.filename, name: d.name || d.filename, manufacturer: d.manufacturer, model: d.model,
    version: d.version == null ? null : String(d.version), control_method: d.control_method, proxies: d.proxies,
    search_types: d.search_types, certified: false, where: ["library"], library: d, category: null, primary_proxy: d.proxies[0] ?? null,
  };
}

export function fromOnline(d: DriverDoc): DriverRow {
  return {
    filename: d.filename, name: d.name || d.filename, manufacturer: d.manufacturer, model: d.model,
    version: d.version == null ? null : String(d.version), control_method: d.control_method, proxies: d.proxies,
    search_types: d.search_types, certified: d.certified, where: ["online"], library: null, category: null,
    primary_proxy: d.primary_proxy || d.proxies[0] || null,
  };
}

/** One row per file name. Earlier lists win a field only when they have something for it:
 *  the controller knows what is installed, the database knows the control method. */
export function merge(...lists: DriverRow[][]): DriverRow[] {
  const out = new Map<string, DriverRow>();
  for (const r of lists.flat()) {
    const had = out.get(key(r.filename));
    if (!had) {
      out.set(key(r.filename), { ...r, where: [...r.where] });
      continue;
    }
    for (const f of ["name", "manufacturer", "model", "version", "control_method"] as const) {
      if (!had[f] || had[f] === had.filename) (had as unknown as Record<string, unknown>)[f] = r[f];
    }
    if (!had.proxies.length) had.proxies = r.proxies;
    had.primary_proxy ??= r.primary_proxy;
    had.category ??= r.category;
    if (!had.search_types.length) had.search_types = r.search_types;
    had.certified ||= r.certified;
    had.library ??= r.library;
    for (const w of r.where) if (!had.where.includes(w)) had.where.push(w);
  }
  return [...out.values()];
}

export const best = (r: DriverRow): Where =>
  r.where.includes("controller") ? "controller" : r.where.includes("library") ? "library" : "online";

/** Every word somewhere in the row, like the tree's filter. */
export function matchesText(r: DriverRow, text: string): boolean {
  const hay = `${r.name} ${r.manufacturer} ${r.model} ${r.filename}`.toLowerCase();
  return text.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** SDDP types compare without case: devices and drivers don't agree on it. */
export const declares = (r: { search_types: string[] }, type: string) =>
  r.search_types.some((t) => t.toLowerCase() === type.toLowerCase());

/** The local sources, indexed for "is this file here?". */
export interface Local {
  /** Null when the controller couldn't be asked (web API off or unreachable). */
  controller: DriverRow[] | null;
  library: DriverRow[];
}

export function whereLocal(local: Local, filename: string): Where | null {
  const k = key(filename);
  if (local.controller?.some((r) => key(r.filename) === k)) return "controller";
  if (local.library.some((r) => key(r.filename) === k)) return "library";
  return null;
}

/** A local driver that says it handles this SDDP type: a device that names no driver file can
 *  still be added when one of these is at hand. */
export function localFor(local: Local, type: string): DriverRow | null {
  return local.controller?.find((r) => declares(r, type)) ?? local.library.find((r) => declares(r, type)) ?? null;
}

export const isDriverFile = (path: string) => /\.(c4z|c4i)$/i.test(path);

// ---- My Drivers' categories ------------------------------------------------------------------

/** Composer files drivers by what they are. Order matters: a keypad dimmer is a keypad. */
export const CATEGORIES: { id: string; title: string; test: RegExp }[] = [
  { id: "controllers", title: "Controllers", test: /controller|director|\bea-?\d|core-?\d|\bca-?\d|io_extender/i },
  { id: "keypads", title: "Keypads", test: /keypad/i },
  { id: "remotes", title: "Remotes & Touch Screens", test: /uidevice|remote|touch_?screen|touchscreen|navigator|sr-?260|halo|neeo/i },
  { id: "lighting", title: "Lighting", test: /light|dimmer|switch_gen|lutron/i },
  { id: "video", title: "TVs & Projectors", test: /^tv$|\btv\b|television|display|projector|bravia|webos|tizen/i },
  { id: "av", title: "Receivers & Amplifiers", test: /receiver|avswitch|amplifier|\bamp\b|_amp|matrix|audio_switch/i },
  { id: "media", title: "Media Sources", test: /media|dvd|blu.?ray|satellite|cable|tuner|stream|apple_tv|roku|sonos|music/i },
  { id: "comfort", title: "Comfort", test: /thermostat|hvac|pool|spa|\bfan\b|ecobee/i },
  { id: "security", title: "Security & Access", test: /security|camera|intercom|door|lock|garage|contact|motion|sensor|relay/i },
  { id: "shades", title: "Blinds & Shades", test: /blind|shade|motorization/i },
  { id: "agents", title: "Agents", test: /agent/i },
];
export const OTHER = { id: "other", title: "Other" };

/** Generic words some controllers put in `category`; they say nothing about the device. */
const VAGUE = new Set(["", "device", "devices", "driver", "other", "unknown"]);

/** The category a driver goes under: the controller's own when it is specific, else guessed
 *  from its proxies, then its file and name. */
export function categoryOf(r: DriverRow): { id: string; title: string } {
  const own = r.category?.trim();
  if (own && !VAGUE.has(own.toLowerCase())) {
    const known = CATEGORIES.find((c) => c.id === own.toLowerCase() || c.title.toLowerCase() === own.toLowerCase());
    return known ?? { id: `c:${own.toLowerCase()}`, title: own.replace(/(^|[\s_])\w/g, (m) => m.toUpperCase()).replace(/_/g, " ") };
  }
  for (const hay of [[r.primary_proxy, ...r.proxies].filter(Boolean).join(" "), `${r.filename} ${r.name}`]) {
    if (!hay) continue;
    const c = CATEGORIES.find((x) => x.test.test(hay));
    if (c) return c;
  }
  return OTHER;
}
