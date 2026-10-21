/** Items › Locations: Composer's templates for sites, buildings, floors and rooms. Each is
 *  proposed under the nearest location of the kind above it (or the one picked in its group):
 *  rooms with `add_room`, the rest with `add_location`. */

import {
  Armchair, Bath, Bed, Briefcase, Building2, Car, ChevronDown, ChevronRight, Clapperboard, CookingPot, DoorClosed, DoorOpen, Dumbbell, Gamepad2,
  Layers, MapPin, Plus, Sofa, Trees, Utensils, WashingMachine, Wine, type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Tip, useDialog } from "../../components/Dialogs";
import { Select } from "../../components/controls";
import type { KindLabel, Op } from "../../api";
import { chain, ofKind, type Indexed } from "../../lib/project";
import type { Shell } from "../../lib/shell";
import { cx } from "../../lib/ui";

const ROOMS: [name: string, icon: LucideIcon][] = [
  ["Living Room", Sofa], ["Family Room", Armchair], ["Kitchen", CookingPot], ["Dining Room", Utensils], ["Theater", Clapperboard],
  ["Foyer", DoorClosed], ["Bedroom", Bed], ["Bathroom", Bath], ["Office", Briefcase], ["Laundry", WashingMachine],
  ["Game Room", Gamepad2], ["Gym", Dumbbell], ["Wine Cellar", Wine], ["Patio", Trees], ["Garage", Car], ["Room", DoorOpen],
];

type Kind = "site" | "building" | "floor" | "room";

/** Composer's location templates, each added under the kind above it. */
const GROUPS: { kind: Kind; title: string; icon: LucideIcon; parent: KindLabel; items: [string, LucideIcon][] }[] = [
  { kind: "site", title: "Sites", icon: MapPin, parent: "project", items: [["Home", MapPin], ["Work", MapPin]] },
  { kind: "building", title: "Buildings", icon: Building2, parent: "site", items: [["House", Building2], ["Building", Building2], ["Office", Building2]] },
  { kind: "floor", title: "Floors", icon: Layers, parent: "building", items: [["Main", Layers], ["First", Layers], ["Second", Layers], ["Basement", Layers]] },
  { kind: "room", title: "Rooms", icon: DoorOpen, parent: "floor", items: ROOMS },
];

export function Locations({ shell, idx, sel, onAdded }: {
  shell: Shell; idx: Map<number, Indexed>; sel: number | null; onAdded: (id: number) => void;
}) {
  // Where each kind goes: the one chosen, else the nearest to the tree's selection, else the first.
  const [chosen, setChosen] = useState<Partial<Record<Kind, string>>>({});
  const [shut, setShut] = useState<Set<Kind>>(new Set());
  const [hot, setHot] = useState<string | null>(null);
  const { ask } = useDialog();
  const selChain = useMemo(() => (sel == null ? [] : chain(idx, sel)), [idx, sel]);
  const targets = useMemo(() => Object.fromEntries(GROUPS.map((g) => {
    const all = ofKind(idx, g.parent);
    const c = chosen[g.kind];
    const id = c != null && all.some((t) => String(t.node.id) === c) ? Number(c)
      : [...selChain].reverse().find((n) => n.kind === g.parent)?.id ?? all[0]?.node.id ?? null;
    return [g.kind, { all, id }];
  })) as Record<Kind, { all: ReturnType<typeof ofKind>; id: number | null }>, [idx, chosen, selChain]);

  const whyNot = (g: (typeof GROUPS)[number]) =>
    !shell.writable ? `${shell.director?.name ?? "This Director"} is read-only`
      : targets[g.kind].id == null ? `The project has no ${g.parent} to put a ${g.kind} in` : undefined;

  const add = async (g: (typeof GROUPS)[number], template: string) => {
    const parent = targets[g.kind].id;
    if (whyNot(g) || parent == null) return;
    const taken = new Set(idx.get(parent)?.node.children.map((c) => c.name.toLowerCase()) ?? []);
    let name = template;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${template} ${n}`;
    const where = idx.get(parent)?.node.name;
    const to = await ask({ title: `New ${g.kind} in “${where}”`, initial: name, placeholder: `${g.title.slice(0, -1)} name`, confirmLabel: `Propose ${g.kind}` });
    if (!to) return;
    const op: Op = g.kind === "room" ? { op: "add_room", floor: parent, name: to } : { op: "add_location", parent, kind: g.kind, name: to };
    const o = await shell.propose([op], `Add the ${to} to ${where}.`);
    const id = o?.status === "applied" ? o.created_item_ids[0] : undefined;
    if (id != null) onAdded(id);
  };

  return (
    <div className="panel-body tw loc" role="tree" aria-label="Location templates">
      {GROUPS.map((g) => {
        const t = targets[g.kind];
        const why = whyNot(g);
        const open = !shut.has(g.kind);
        return (
          <div key={g.kind} className="loc-group">
            <div className="tw-row head" onClick={() => setShut((s) => { const n = new Set(s); if (n.has(g.kind)) n.delete(g.kind); else n.add(g.kind); return n; })}>
              <span className="tw-tw hit">{open ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}</span>
              <span className="tw-ic"><g.icon size={14} strokeWidth={1.8} /></span><span className="tw-label">{g.title}</span>
              {/* Only worth asking where when there's a choice. */}
              {open && g.parent !== "project" && t.all.length > 1 && (
                <span className="spread loc-target" onClick={(e) => e.stopPropagation()}>
                  <span className="dim small">in</span>
                  <Select value={t.id != null ? String(t.id) : ""} onValueChange={(v) => setChosen((c) => ({ ...c, [g.kind]: v }))} label={`${g.title} go in`}
                          options={t.all.map((f) => ({ value: String(f.node.id), label: f.location ? `${f.node.name} — ${f.location.split(" › ").pop()}` : f.node.name }))} />
                </span>
              )}
            </div>
            {open && g.items.map(([n, Icon]) => {
              const key = `${g.kind}:${n}`;
              return (
                <div key={key} className={cx("tw-row loc-room", hot === key && "sel")} style={{ paddingLeft: 26 }} role="treeitem" tabIndex={0}
                     aria-selected={hot === key} onClick={() => setHot(key)} onDoubleClick={() => void add(g, n)}
                     onKeyDown={(e) => { if (e.key === "Enter") void add(g, n); }}>
                  <span className="tw-ic"><Icon size={14} strokeWidth={1.7} /></span>
                  <span className="tw-label">{n}</span>
                  <Tip text={why ?? `Add a ${g.kind} in ${idx.get(t.id!)?.node.name}`} side="left">
                    <span className="spread"><button className="icon-btn loc-add" aria-label={`Add ${n}`} disabled={!!why}
                                                     onClick={(e) => { e.stopPropagation(); void add(g, n); }}><Plus size={13} strokeWidth={2} /></button></span>
                  </Tip>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
