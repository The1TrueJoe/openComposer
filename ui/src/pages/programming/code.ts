/** The Programming page's arithmetic, without the UI: where a new line goes in an event's
 *  script (and where it may not), what Composer would call the line, and which commands and
 *  conditionals a device offers. The rules mirror crates/c4/src/program.rs, which checks them
 *  again before anything is proposed. */

import { useEffect, useState } from "react";
import {
  api, errText, type CodeLineView, type CommandDef, type CommandParam, type ConditionalView, type ItemDetail, type LineRole,
  type Logic, type TreeNode, type VariableRow,
} from "../../api";
import { commandsOf, humanize, type Available } from "../../lib/control";

/** A place for a new (or moved) line: `before` under `parent`, the `add_code` op's own terms
 *  (`before` 0 = the end of `parent`'s block, `parent` 0 = top level). `index` is the flat row
 *  the marker sits above (`lines.length` = below the last row), `depth` how far it's indented. */
export interface Slot {
  index: number;
  depth: number;
  parent: number;
  before: number;
}

/** What a line is. Older backends don't say; their lines are commands unless the kind says not. */
export function roleOf(l: CodeLineView): LineRole {
  if (l.role) return l.role;
  switch (l.kind) {
    case 2: return "if";
    case 3: return "while";
    case 4: return "else";
    case 5: return "comment";
    case 6: return "operator";
    default: return "command";
  }
}

/** Lines that hold other lines: If, While, Else. */
export const isBlock = (l: CodeLineView | undefined) => !!l && ["if", "while", "else"].includes(roleOf(l));

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

/** The row just past line `i` and everything nested under it. */
export function subtreeEnd(lines: CodeLineView[], i: number): number {
  const d = lines[i]?.depth ?? 0;
  let j = i + 1;
  while (j < lines.length && lines[j].depth > d) j++;
  return j;
}

/** How many lines removing this one takes with it (everything nested under it, and an If's Else
 *  with everything under that: Director removes them together). */
export function nestedUnder(lines: CodeLineView[], index: number): number {
  let end = subtreeEnd(lines, index);
  if (roleOf(lines[index]) === "if" && elseAt(lines, end, lines[index].depth)) end = subtreeEnd(lines, end);
  return end - index - 1;
}

const elseAt = (lines: CodeLineView[], j: number, depth: number) => j < lines.length && lines[j].depth === depth && roleOf(lines[j]) === "else";

/** The slot above row `i` (or the end of the script). */
export function slotBefore(lines: CodeLineView[], i: number): Slot {
  if (i >= lines.length) return { index: lines.length, depth: 0, parent: 0, before: 0 };
  return { index: i, depth: lines[i].depth, parent: parentsOf(lines)[i], before: lines[i].id };
}

/** The slot right after line `i` (and what's nested under it), in the same block. */
export function slotAfter(lines: CodeLineView[], i: number): Slot {
  const d = lines[i].depth, j = subtreeEnd(lines, i);
  return { index: j, depth: d, parent: parentsOf(lines)[i], before: j < lines.length && lines[j].depth === d ? lines[j].id : 0 };
}

/** The first slot inside block `i`. */
export function slotInside(lines: CodeLineView[], i: number): Slot {
  const d = lines[i].depth;
  const first = i + 1 < lines.length && lines[i + 1].depth === d + 1 ? lines[i + 1].id : 0;
  return { index: i + 1, depth: d + 1, parent: lines[i].id, before: first };
}

/** The indents a line dropped in the gap above row `j` can take: from the row below's level up
 *  to inside the row above (when that's a block). */
export function gapDepths(lines: CodeLineView[], j: number): [number, number] {
  const below = j < lines.length ? lines[j].depth : 0;
  if (j === 0) return [below, below];
  const above = lines[j - 1];
  return [below, Math.max(below, above.depth + (isBlock(above) ? 1 : 0))];
}

/** The slot in the gap above row `j` at indent `depth` (clamped to what the gap allows): the
 *  end of a block is its own slot, one level in from the gap below it. */
export function slotAtGap(lines: CodeLineView[], j: number, depth: number): Slot {
  const [lo, hi] = gapDepths(lines, j);
  const d = Math.max(lo, Math.min(hi, depth));
  if (j === 0 || !lines.length) return slotBefore(lines, 0);
  const above = lines[j - 1];
  if (d === above.depth + 1 && isBlock(above)) return slotInside(lines, j - 1);
  // The line above at this indent (the row itself, or the block it ends).
  let k = j - 1;
  while (k > 0 && lines[k].depth > d) k--;
  return slotAfter(lines, k);
}

/** Where `parent`/`before` land in these lines (after a reload the rows may have moved). */
export function slotFrom(lines: CodeLineView[], parent: number, before: number): Slot {
  if (before) {
    const i = lines.findIndex((l) => l.id === before);
    if (i >= 0) return slotBefore(lines, i);
  }
  if (parent) {
    const i = lines.findIndex((l) => l.id === parent);
    if (i >= 0 && isBlock(lines[i])) {
      const end = subtreeEnd(lines, i);
      return end === i + 1 ? slotInside(lines, i) : { ...slotAfter(lines, lastChild(lines, i)), index: end };
    }
  }
  return slotBefore(lines, lines.length);
}

function lastChild(lines: CodeLineView[], i: number): number {
  const d = lines[i].depth;
  let last = i + 1;
  for (let k = i + 1; k < lines.length && lines[k].depth > d; k++) if (lines[k].depth === d + 1) last = k;
  return last;
}

/** The rows directly under `parent`, in order. */
function siblings(lines: CodeLineView[], parent: number): number[] {
  const parents = parentsOf(lines);
  const pd = parent ? (lines.find((l) => l.id === parent)?.depth ?? -1) + 1 : 0;
  return lines.map((_, i) => i).filter((i) => parents[i] === parent && lines[i].depth === pd);
}

/** Why a new line of this kind can't go at `s`, or null when it can. */
export function slotProblem(lines: CodeLineView[], s: Slot, adding: "line" | "else" = "line"): string | null {
  const next = s.before ? lines.find((l) => l.id === s.before) : undefined;
  if (next && roleOf(next) === "else") return "Nothing can go between an If and its Else.";
  if (adding === "else") {
    const sib = siblings(lines, s.parent);
    const at = s.before ? sib.findIndex((i) => lines[i].id === s.before) : sib.length;
    const prev = at > 0 ? lines[sib[at - 1]] : undefined;
    if (!prev || roleOf(prev) !== "if") return "An Else goes right after an If that has none: drop it just below the If's block.";
  }
  return null;
}

/** "above line 3", "at the end of “Else”", "at the end": where a slot is, in words. */
export function slotWhere(lines: CodeLineView[], s: Slot): string {
  if (s.index < lines.length && s.before) return `above line ${s.index + 1}`;
  const p = s.parent ? lines.find((l) => l.id === s.parent) : undefined;
  return p ? `at the end of “${p.text}”` : "at the end";
}

/** Where an Else for the If on row `i` goes, or null when that If has one already. */
export function elseSlot(lines: CodeLineView[], i: number): Slot | null {
  if (roleOf(lines[i]) !== "if") return null;
  const s = slotAfter(lines, i);
  return slotProblem(lines, s, "else") ? null : s;
}

/** Lines that won't run: disabled ones, everything inside a disabled block, and the Else of a
 *  disabled If (Composer greys those out the same way). */
export function offRows(lines: CodeLineView[]): boolean[] {
  const off: boolean[] = [];
  const stack: boolean[] = [];
  // Per depth: whether the line before (a sibling) was an If that won't run.
  const ifOff: boolean[] = [];
  lines.forEach((l, i) => {
    stack.length = l.depth;
    ifOff.length = l.depth + 1;
    const inherited = l.depth > 0 && !!stack[l.depth - 1];
    const elseOfOff = roleOf(l) === "else" && !!ifOff[l.depth];
    off[i] = !l.enabled || inherited || elseOfOff;
    stack[l.depth] = off[i];
    ifOff[l.depth] = roleOf(l) === "if" ? off[i] : false;
  });
  return off;
}

/** Why a line can't be moved, or null when it can. An Else moves with its If. */
export function moveBlocked(lines: CodeLineView[], index: number): string | null {
  const l = lines[index];
  if (!l) return "No line selected";
  if (roleOf(l) === "else") return "An Else moves with its If: move the If.";
  if (roleOf(l) === "operator") return "Parts of a compound condition can't be moved here.";
  return null;
}

/** Where a move lands: `move_code`'s `parent` and `before`. */
export interface Place {
  parent: number;
  before: number;
}

/** A line with what goes along with it when it moves: an If's Else follows it. */
function group(lines: CodeLineView[], i: number): number {
  let end = subtreeEnd(lines, i);
  if (roleOf(lines[i]) === "if" && elseAt(lines, end, lines[i].depth)) end = subtreeEnd(lines, end);
  return end;
}

/** Moving a line one step among its siblings: above the previous one (an If and its Else count
 *  as one), or below the next one. Null at the top or bottom of its block. */
export function stepMoves(lines: CodeLineView[], i: number): { up: Place | null; down: Place | null } {
  const parent = parentsOf(lines)[i];
  const sib = siblings(lines, parent);
  const at = sib.indexOf(i);
  let up: Place | null = null, down: Place | null = null;
  if (at > 0) {
    let k = at - 1;
    if (roleOf(lines[sib[k]]) === "else" && k > 0) k--;
    up = { parent, before: lines[sib[k]].id };
  }
  const after = group(lines, i);
  const n = sib.find((x) => x >= after);
  if (n != null) {
    const beyond = group(lines, n);
    const next = sib.find((x) => x >= beyond);
    down = { parent, before: next != null ? lines[next].id : 0 };
  }
  return { up, down };
}

/** Why line `i` can't move to `s`, "" when it would stay where it is, or null when it can. */
export function moveProblem(lines: CodeLineView[], i: number, s: Slot): string | null {
  const blocked = moveBlocked(lines, i);
  if (blocked) return blocked;
  const end = group(lines, i);
  const inside = lines.slice(i, end).map((l) => l.id);
  const ownElse = end > subtreeEnd(lines, i) ? lines[subtreeEnd(lines, i)].id : 0;
  if (s.before === lines[i].id || (ownElse && s.before === ownElse)) return "";
  if (inside.includes(s.parent) || (s.before && inside.includes(s.before))) return "A line can't go inside itself.";
  const parent = parentsOf(lines)[i];
  if (s.parent === parent) {
    const next = end < lines.length && lines[end].depth === lines[i].depth ? lines[end].id : 0;
    if (s.before === next) return "";
  }
  return slotProblem(lines, s);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w: string, flags = "") => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(w)}(?![A-Za-z0-9_])`, flags);
/** `w` replaced where it stands alone (so NAME doesn't hit BTN_NAME). */
const word = (t: string, w: string, v: string) => t.replace(wordRe(w, "g"), () => v);

/** The line as Composer stores it: the driver's description template with the parameters
 *  filled in and `NAME` left for the target (Director fills that in when it shows the line).
 *  Templates name parameters either as PARAM1, PARAM2… (Control4's convention) or by name. */
export function displayFor(def: CommandDef, params: CommandParam[]): string {
  let t = def.description.trim();
  if (!t || t === def.name) t = `${humanize(def.name)} on NAME`;
  t = t.replace(/\bPARAM(\d+)\b/g, (m, n) => params[Number(n) - 1]?.value ?? m);
  for (const p of params) {
    if (p.name === "NAME" || !p.name) continue;
    t = word(t, p.name, p.value);
  }
  return t;
}

/** A template with the target's name in it, for showing. */
export const withName = (display: string, name: string) => word(display, "NAME", name);

export const LOGIC_WORDS: Record<Logic, string> = {
  equal: "Equal To", not_equal: "Not Equal To", less_than: "Less Than", less_than_or_equal: "Less Than Or Equal To",
  greater_than: "Greater Than", greater_than_or_equal: "Greater Than Or Equal To",
};
export const LOGIC_SYMBOL: Record<Logic, string> = {
  equal: "=", not_equal: "≠", less_than: "<", less_than_or_equal: "≤", greater_than: ">", greater_than_or_equal: "≥",
};

/** An If/While line's text, as the backend will store it (program.rs `Condition::display`), for
 *  previews: the conditional's description with LOGIC and the values filled in. */
export function conditionText(loop: boolean, def: ConditionalView, logic: Logic | null, params: CommandParam[], name: string): string {
  let t = def.description.trim() || `NAME ${def.name}`;
  if (logic) t = word(t, "LOGIC", LOGIC_WORDS[logic]);
  for (const p of params) {
    // A typed conditional's VALUE fills whichever value macro its description uses.
    const key = def.type && p.name === "VALUE" ? ["INTEGER", "NUMBER", "STRING", "DEVICE", "ROOM", "VALUE"].find((m) => wordRe(m).test(t)) ?? "VALUE" : p.name;
    t = word(t, key, p.value);
  }
  return `${loop ? "While" : "If"} ${withName(t, name)}`;
}

/** A variable as lines name it: the project's own by name, a device's as "Device->NAME". */
export const varLabel = (v: Pick<VariableRow, "device" | "name" | "owner">) => (v.device === 100001 ? v.name : `${v.owner}->${v.name}`);

/** The keyword a control-flow line starts with, read from its text. */
export const flowWord = (text: string) => /^(If|Else If|ElseIf|Else|While|Loop|Repeat|Stop|Break|delay)\b/.exec(text.trim())?.[1] ?? null;

/** A device command line. */
export const isCommand = (l: CodeLineView) => roleOf(l) === "command";

/** How a line that isn't a device command is drawn: its role, and the keyword to pick out. */
export function flowOf(l: CodeLineView): { role: LineRole; word: string | null } | null {
  const role = roleOf(l);
  if (role === "command") return null;
  if (role === "comment" || role === "variable") return { role, word: null };
  return { role, word: flowWord(l.text) };
}

/** Whether this line can be switched off (Composer doesn't offer it for comments). */
export const canToggle = (l: CodeLineView) => roleOf(l) !== "comment" && roleOf(l) !== "operator";

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

/** A conditional and the item it's on (the device itself, or one of its proxies). */
export interface Testable {
  target: number;
  targetName: string;
  role: string;
  def: ConditionalView;
}

/** Everything a device can be sent: its own commands and its proxies' (a built-in proxy's
 *  named from its templates), and for a proxy that names none, what its capabilities show it
 *  takes — the control panel's rule (`commandsOf` in lib/control.ts). Also what it can be
 *  tested for (its conditionals and its proxies'). */
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
  const roleFor = (x: ItemDetail, i: number) => (i === 0 && x.kind !== "proxy" ? "device" : (x.driver ?? "proxy").replace(/\.c4[iz]$/i, ""));
  // Programming may send what a device declares even when it can't do it; only commands known
  // from nothing at all (no live variables are read here) are missing.
  const available: Available[] = commandsOf(items ?? []);
  const testable: Testable[] = (items ?? []).flatMap((x, i) =>
    (x.conditionals ?? []).map((def) => ({ target: x.id, targetName: x.name, role: roleFor(x, i), def })));
  return { items, available, testable, error: id != null && state.id === id ? state.error : null, loading: id != null && !items && !state.error };
}
