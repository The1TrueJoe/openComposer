/** How a semantic project diff is organised on screen: which section a change belongs in,
 *  whether it adds, removes or changes something, and where inside a changed value the
 *  difference is. No DOM here — `diff.check.ts` runs this under node. */

import type { Change, ItemKind, ItemRef } from "../api/types.ts";

export type SectionId = "items" | "properties" | "connections" | "network" | "variables" | "schedule" | "agents" | "programming";
export type Effect = "added" | "removed" | "changed";

export const SECTIONS: readonly { id: SectionId; title: string }[] = [
  { id: "items", title: "Rooms & devices" },
  { id: "properties", title: "Properties" },
  { id: "connections", title: "Connections" },
  { id: "network", title: "Network" },
  { id: "variables", title: "Variables" },
  { id: "schedule", title: "Scheduler" },
  { id: "agents", title: "Agents" },
  { id: "programming", title: "Programming" },
];

export function sectionOf(c: Change): SectionId {
  switch (c.kind) {
    case "item_added": case "item_removed": case "item_renamed": case "item_moved": case "driver_changed":
      return "items";
    case "property_changed":
      return "properties";
    case "connection_added": case "connection_removed":
      return "connections";
    case "network_added": case "network_removed": case "network_changed":
      return "network";
    case "variable_added": case "variable_removed": case "variable_changed":
      return "variables";
    case "schedule_added": case "schedule_removed": case "schedule_changed":
      return "schedule";
    case "agent_record_added": case "agent_record_removed": case "agent_record_changed":
      return "agents";
    case "programming_changed":
      return "programming";
  }
}

export function effectOf(c: Change): Effect {
  if (c.kind.endsWith("_added")) return "added";
  if (c.kind.endsWith("_removed")) return "removed";
  return "changed";
}

/** Changes per section, in section order, empty sections left out. */
export function group(changes: readonly Change[]): { id: SectionId; title: string; changes: Change[] }[] {
  const by = new Map<SectionId, Change[]>();
  for (const c of changes) {
    const s = sectionOf(c);
    const list = by.get(s);
    if (list) list.push(c);
    else by.set(s, [c]);
  }
  return SECTIONS.filter((s) => by.has(s.id)).map((s) => ({ ...s, changes: by.get(s.id)! }));
}

export function tally(changes: readonly Change[]): Record<Effect, number> {
  const t = { added: 0, removed: 0, changed: 0 };
  for (const c of changes) t[effectOf(c)]++;
  return t;
}

export function kindLabel(k: ItemKind): string {
  return typeof k === "string" ? k : "item";
}

/** The item a change is about, for the ones that have exactly one. */
export function subjectOf(c: Change): ItemRef | null {
  if ("item" in c) return c.item;
  if ("owner" in c) return c.owner;
  return null;
}

/** Whether a change was caused by removing something else (a connection of a removed device). */
export function isCascade(c: Change): boolean {
  return "cascade" in c && c.cascade;
}

// ---- inline highlighting -------------------------------------------------------------------

export interface Seg {
  text: string;
  /** Present on only one side: removed text on the "from" side, added on the "to" side. */
  changed: boolean;
}

const TOKEN = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;

/** LCS over tokens is quadratic; beyond this a value is shown as wholly replaced. */
const MAX_CELLS = 250_000;

function merge(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && last.changed === s.changed) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/** One word against another: highlight what differs between the common prefix and suffix,
 *  so `192.168.1.41` → `192.168.1.52` lights up only the last octet. */
function charDiff(a: string, b: string): { from: Seg[]; to: Seg[] } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const mid = (x: string): Seg[] => [
    { text: x.slice(0, p), changed: false },
    { text: x.slice(p, x.length - s), changed: true },
    { text: x.slice(x.length - s), changed: false },
  ];
  return { from: merge(mid(a)), to: merge(mid(b)) };
}

/** Where two versions of a value differ, by word, falling back to characters for single
 *  words (addresses, numbers, identifiers) where a word diff would just mark everything. */
export function inlineDiff(a: string, b: string): { from: Seg[]; to: Seg[] } {
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  if (ta.length <= 1 && tb.length <= 1) return charDiff(a, b);
  if (ta.length * tb.length > MAX_CELLS) {
    return { from: [{ text: a, changed: true }], to: [{ text: b, changed: true }] };
  }
  const n = ta.length, m = tb.length;
  // lcs[i][j]: length of the common subsequence of ta[i..] and tb[j..], flattened.
  const lcs = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[at(i, j)] = ta[i] === tb[j] ? lcs[at(i + 1, j + 1)] + 1 : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
    }
  }
  const from: Seg[] = [], to: Seg[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ta[i] === tb[j]) {
      from.push({ text: ta[i], changed: false });
      to.push({ text: tb[j], changed: false });
      i++; j++;
    } else if (j < m && (i === n || lcs[at(i, j + 1)] >= lcs[at(i + 1, j)])) {
      to.push({ text: tb[j++], changed: true });
    } else {
      from.push({ text: ta[i++], changed: true });
    }
  }
  return { from: merge(from), to: merge(to) };
}

// ---- the affected-devices graph ------------------------------------------------------------

export interface GraphNode {
  key: string;
  name: string;
  room: string;
  /** 0 = only provides, 2 = only consumes, 1 = both. */
  column: 0 | 1 | 2;
  effect: Effect | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
  effect: "added" | "removed";
  cascade: boolean;
}

/** Devices touched by connection changes, and the edges between them. Keyed by id and name:
 *  a predicted device has a guessed id that may collide with nothing else, but a compare
 *  between two projects can have the same id on both sides meaning different things. */
export function affectedGraph(changes: readonly Change[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode & { provides: boolean; consumes: boolean }>();
  const edges: GraphEdge[] = [];
  const itemEffect = new Map<string, Effect>();
  for (const c of changes) {
    if (c.kind === "item_added" || c.kind === "item_removed") itemEffect.set(keyOf(c.item), effectOf(c));
  }
  const node = (r: ItemRef, provides: boolean) => {
    const key = keyOf(r);
    const n = nodes.get(key) ?? {
      key, name: r.name, room: r.location[r.location.length - 1] ?? "", column: 0 as const,
      effect: itemEffect.get(key) ?? null, provides: false, consumes: false,
    };
    if (provides) n.provides = true;
    else n.consumes = true;
    nodes.set(key, n);
    return key;
  };
  for (const c of changes) {
    if (c.kind !== "connection_added" && c.kind !== "connection_removed") continue;
    const k = c.connection;
    edges.push({
      from: node(k.provider.device, true),
      to: node(k.consumer.device, false),
      label: k.classes.join(" · "),
      effect: c.kind === "connection_added" ? "added" : "removed",
      cascade: c.kind === "connection_removed" && c.cascade,
    });
  }
  const out = [...nodes.values()].map(({ provides, consumes, ...n }) => ({
    ...n, column: (provides && consumes ? 1 : provides ? 0 : 2) as GraphNode["column"],
  }));
  return { nodes: out, edges };
}

function keyOf(r: ItemRef): string {
  return `${r.id}:${r.name}`;
}
