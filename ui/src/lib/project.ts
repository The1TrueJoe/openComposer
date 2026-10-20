/** Questions every pane asks of the project tree: where is this, which rooms are there,
 *  what matches a filter. */

import type { KindLabel, TreeNode } from "../api/types.ts";

export interface Indexed {
  node: TreeNode;
  parent: number | null;
}

export function indexTree(root: TreeNode | null): Map<number, Indexed> {
  const out = new Map<number, Indexed>();
  const walk = (n: TreeNode, parent: number | null) => {
    out.set(n.id, { node: n, parent });
    for (const c of n.children) walk(c, n.id);
  };
  if (root) walk(root, null);
  return out;
}

/** Top-down chain from the root to `id`, inclusive. */
export function chain(idx: Map<number, Indexed>, id: number): TreeNode[] {
  const out: TreeNode[] = [];
  for (let at: number | null = id; at != null; at = idx.get(at)?.parent ?? null) {
    const e = idx.get(at);
    if (!e) break;
    out.unshift(e.node);
  }
  return out;
}

export function ofKind(idx: Map<number, Indexed>, kind: KindLabel): { node: TreeNode; location: string }[] {
  return [...idx.values()]
    .filter((e) => e.node.kind === kind)
    .map((e) => ({
      node: e.node,
      // Without the project itself: every location would start with it.
      location: chain(idx, e.node.id).slice(1, -1).map((n) => n.name).join(" › "),
    }));
}

/** The tree with only matching rows and the rows above them. Matches keep their whole
 *  subtree, so filtering for a room still shows what is in it. */
export function filterTree(n: TreeNode, q: string): TreeNode | null {
  const needle = q.trim().toLowerCase();
  if (!needle) return n;
  const hit = n.name.toLowerCase().includes(needle) || !!n.driver?.toLowerCase().includes(needle);
  if (hit) return n;
  const children = n.children.map((c) => filterTree(c, needle)).filter((c): c is TreeNode => !!c);
  return children.length ? { ...n, children } : null;
}

/** The containers a kind of item can be moved into. */
export function parentKindFor(kind: KindLabel): KindLabel | null {
  switch (kind) {
    case "device": return "room";
    case "room": return "floor";
    case "floor": return "building";
    case "building": return "site";
    default: return null;
  }
}
