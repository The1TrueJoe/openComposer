// Run by `npm run check` under node: the parts of the diff view that are logic, not layout.
import assert from "node:assert/strict";
import type { Change, ItemRef } from "../api/types.ts";
import { affectedGraph, group, inlineDiff, tally } from "./diff.ts";

const text = (segs: { text: string; changed: boolean }[], changed: boolean) =>
  segs.filter((s) => s.changed === changed).map((s) => s.text).join("");

// One word: only the differing middle is marked.
{
  const d = inlineDiff("192.168.1.41", "192.168.1.52");
  assert.equal(text(d.from, true), "41");
  assert.equal(text(d.to, true), "52");
  assert.equal(text(d.to, false), "192.168.1.");
}

// Several words: whole words are marked, shared ones are not.
{
  const d = inlineDiff("Input HDMI 1 on power", "Input HDMI 2 on power");
  assert.equal(text(d.from, true), "1");
  assert.equal(text(d.to, true), "2");
  assert.equal(d.to.map((s) => s.text).join(""), "Input HDMI 2 on power");
}

// Empty to something: everything is new.
{
  const d = inlineDiff("", "hello");
  assert.equal(text(d.to, true), "hello");
  assert.equal(d.from.length, 0);
}

const ref = (id: number, name: string): ItemRef => ({ id, name, item_kind: "device", location: ["Home", "Main", "Living"] });
const changes: Change[] = [
  { kind: "item_removed", item: ref(5, "Old TV"), driver: "tv.c4i", descendants: 1 },
  { kind: "property_changed", item: ref(6, "AVR"), property: "Volume", from: "10", to: "20" },
  {
    kind: "connection_removed", cascade: true,
    connection: { classes: ["HDMI"], provider: { device: ref(6, "AVR"), binding: 2000, connection: "HDMI OUT" },
      consumer: { device: ref(5, "Old TV"), binding: 2001, connection: "HDMI 1" } },
  },
];

// Sections come out in their fixed order regardless of input order.
assert.deepEqual(group(changes).map((s) => s.id), ["items", "properties", "connections"]);
assert.deepEqual(tally(changes), { added: 0, removed: 2, changed: 1 });

// The graph knows which side provides and that the TV was removed.
{
  const g = affectedGraph(changes);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].cascade, true);
  const tv = g.nodes.find((n) => n.name === "Old TV")!;
  assert.equal(tv.column, 2);
  assert.equal(tv.effect, "removed");
  assert.equal(g.nodes.find((n) => n.name === "AVR")!.column, 0);
}

console.log("diff.check: ok");
