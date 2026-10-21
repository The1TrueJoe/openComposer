/** The Programming page's arithmetic, without the UI: where a new line goes in an event's
 *  script, what Composer would call the line, and which commands a device can be sent. */

import { useEffect, useState } from "react";
import { api, errText, type CodeLineView, type CommandDef, type CommandParam, type ItemDetail, type TreeNode } from "../../api";
import { humanize, standardFor, type Available } from "../../lib/control";

/** A place between two lines of a script: new lines are added with `before` under `parent`
 *  (the `add_code` op's own terms). `index` is the flat row it sits above; the end is
 *  `lines.length`. */
export interface Slot {
  index: number;
  parent: number;
  before: number;
}

/** The line each line is nested under (0 = top level), from the depths views.rs flattens the
 *  tree into: a line's parent is the nearest line above it one level shallower. */
export function parentsOf(lines: CodeLineView[]): number[] {
  const stack: number[] = [];
  return lines.map((l) => {
    stack.length = l.depth;
    const parent = l.depth > 0 ? stack[l.depth - 1] ?? 0 : 0;
    stack[l.depth] = l.id;
    return parent;
  });
}

/** The slot above row `index`, or the end of the script. ponytail: "the end of a block" (after
 *  an If's last child) isn't a slot of its own — the gap below a block is at the outer level;
 *  the upgrade is a slot per closing depth. */
export function slotAt(lines: CodeLineView[], index: number): Slot {
  if (index >= lines.length) return { index: lines.length, parent: 0, before: 0 };
  return { index, parent: parentsOf(lines)[index], before: lines[index].id };
}

/** How many lines removing this one takes with it (everything nested under it). */
export function nestedUnder(lines: CodeLineView[], index: number): number {
  const d = lines[index]?.depth ?? 0;
  let n = 0;
  for (let i = index + 1; i < lines.length && lines[i].depth > d; i++) n++;
  return n;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The line as Composer stores it: the driver's description template with the parameters
 *  filled in and `NAME` left for the target (Director fills that in when it shows the line).
 *  Templates name parameters either as PARAM1, PARAM2… (Control4's convention) or by name. */
export function displayFor(def: CommandDef, params: CommandParam[]): string {
  let t = def.description.trim();
  if (!t || t === def.name) t = `${humanize(def.name)} on NAME`;
  t = t.replace(/\bPARAM(\d+)\b/g, (m, n) => params[Number(n) - 1]?.value ?? m);
  for (const p of params) {
    if (p.name === "NAME" || !p.name) continue;
    t = t.replace(new RegExp(`\\b${escapeRe(p.name)}\\b`, "g"), p.value);
  }
  return t;
}

/** A template with the target's name in it, for showing. */
export const withName = (display: string, name: string) => display.replace(/\bNAME\b/g, name);

/** The keyword a control-flow line starts with, read from its text. */
export const flowWord = (text: string) => /^(If|Else If|ElseIf|Else|While|Loop|Repeat|Stop)\b/.exec(text.trim())?.[1] ?? null;

/** A device command line: Director's kind 1, or a line whose command views.rs could read. */
export const isCommand = (l: CodeLineView) => l.kind === 1 || !!l.command;

/** How a control-flow line is drawn, or null for a command line. Director's kind says it's not
 *  a command; the keyword comes from the text. Without a kind (an older backend) the text is
 *  all there is, so only a recognised keyword makes it flow. */
export function flowOf(l: CodeLineView): { word: string | null } | null {
  if (isCommand(l)) return null;
  const word = flowWord(l.text);
  return l.kind != null || word ? { word } : null;
}

/** Why a line can't be moved, or null when it can. Moving is remove + add, so it takes a plain
 *  command line whose command is known, with nothing nested under it. */
export function moveBlocked(lines: CodeLineView[], index: number): string | null {
  const l = lines[index];
  if (!l) return "No line selected";
  if (!isCommand(l) || !l.command) return "Only device-command lines can be moved; conditionals and loops can't be yet.";
  if (nestedUnder(lines, index) > 0) return "This line has lines nested under it, which can't be moved yet.";
  if (!l.target || l.display == null) return "openComposer can't read this line's command, so it can't put it anywhere else.";
  return null;
}

/** Where a move lands: `add_code`'s `parent` and `before`. */
export interface Place {
  parent: number;
  before: number;
}

/** Moving a line one step among its siblings: above the previous one, or below the next one
 *  (and anything nested under that). Null at the top or bottom of its block. The line itself
 *  has no children (see `moveBlocked`), so every `before` still exists once it's removed. */
export function stepMoves(lines: CodeLineView[], i: number): { up: Place | null; down: Place | null } {
  const parents = parentsOf(lines);
  const d = lines[i]?.depth ?? 0, p = parents[i];
  let k = i - 1;
  while (k >= 0 && lines[k].depth > d) k--;
  const up = k >= 0 && lines[k].depth === d && parents[k] === p ? { parent: p, before: lines[k].id } : null;
  let down: Place | null = null;
  const j = i + 1;
  if (j < lines.length && lines[j].depth === d && parents[j] === p) {
    let m = j + 1;
    while (m < lines.length && lines[m].depth > d) m++;
    down = { parent: p, before: m < lines.length && lines[m].depth === d ? lines[m].id : 0 };
  }
  return { up, down };
}

/** Dropping line `i` at `s` would leave it where it is. */
export function staysPut(lines: CodeLineView[], i: number, s: Slot): boolean {
  return s.before === lines[i]?.id || (s.index === i + 1 && s.parent === parentsOf(lines)[i]);
}

/** The tree node an item is drawn as: itself, or the device whose sole proxy it is. */
export function nodeIndex(root: TreeNode | null | undefined): Map<number, TreeNode> {
  const out = new Map<number, TreeNode>();
  const walk = (n: TreeNode) => {
    out.set(n.id, n);
    if (n.proxy != null && !out.has(n.proxy)) out.set(n.proxy, n);
    n.children.forEach(walk);
  };
  if (root) walk(root);
  return out;
}

/** Everything a device can be sent: its own commands and its proxies', and Control4's
 *  standard commands for a proxy that lists none (Director keeps the built-in proxies' commands
 *  to itself). The same rule as the control panel (pages/design/DeviceControl.tsx). */
export function useCommands(id: number | null, rev: number) {
  const [state, setState] = useState<{ id: number | null; items: ItemDetail[] | null; error: string | null }>({ id: null, items: null, error: null });
  useEffect(() => {
    if (id == null) return;
    let gone = false;
    setState((s) => ({ id, items: s.id === id ? s.items : null, error: null }));
    (async () => {
      try {
        const d = await api.item(id);
        const proxies = await Promise.all(d.children.filter((c) => c.kind === "proxy").map((c) => api.item(c.id)));
        if (!gone) setState({ id, items: [d, ...proxies], error: null });
      } catch (e) {
        if (!gone) setState({ id, items: null, error: errText(e) });
      }
    })();
    return () => { gone = true; };
  }, [id, rev]);

  const items = id != null && state.id === id ? state.items : null;
  const available: Available[] = (items ?? []).flatMap((x, i) => {
    const role = i === 0 && x.kind !== "proxy" ? "device" : (x.driver ?? "proxy").replace(/\.c4[iz]$/i, "");
    const own = (x.commands ?? []).map((def) => ({ target: x.id, targetName: x.name, role, def, standard: false }));
    if (own.length || (i === 0 && x.kind !== "proxy")) return own;
    return standardFor(x.driver).map((def) => ({ target: x.id, targetName: x.name, role, def, standard: true }));
  });
  return { items, available, error: id != null && state.id === id ? state.error : null, loading: id != null && !items && !state.error };
}
