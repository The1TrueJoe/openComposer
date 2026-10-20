/** Items › Locations: Composer's templates for sites, buildings, floors and rooms. Only rooms
 *  can be added today (the backend's `add_room`, on a floor); the other kinds are listed,
 *  disabled, so the shape is familiar and it's clear what's missing. */

import {
  Armchair, Bath, Bed, Briefcase, Building2, Car, ChevronDown, Clapperboard, CookingPot, DoorClosed, DoorOpen, Dumbbell, Gamepad2,
  Layers, MapPin, Plus, Sofa, Trees, Utensils, WashingMachine, Wine, type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Tip, useDialog } from "../../components/Dialogs";
import { Select } from "../../components/controls";
import { chain, ofKind, type Indexed } from "../../lib/project";
import type { Shell } from "../../lib/shell";
import { cx } from "../../lib/ui";

const ROOMS: [name: string, icon: LucideIcon][] = [
  ["Living Room", Sofa], ["Family Room", Armchair], ["Kitchen", CookingPot], ["Dining Room", Utensils], ["Theater", Clapperboard],
  ["Foyer", DoorClosed], ["Bedroom", Bed], ["Bathroom", Bath], ["Office", Briefcase], ["Laundry", WashingMachine],
  ["Game Room", Gamepad2], ["Gym", Dumbbell], ["Wine Cellar", Wine], ["Patio", Trees], ["Garage", Car], ["Room", DoorOpen],
];

const NOT_YET: { title: string; icon: LucideIcon; items: string[] }[] = [
  { title: "Sites", icon: MapPin, items: ["Home", "Work"] },
  { title: "Buildings", icon: Building2, items: ["House", "Building", "Office"] },
  { title: "Floors", icon: Layers, items: ["Main", "First", "Second", "Basement"] },
];

export function Locations({ shell, idx, sel, onAdded }: {
  shell: Shell; idx: Map<number, Indexed>; sel: number | null; onAdded: (id: number) => void;
}) {
  const floors = useMemo(() => ofKind(idx, "floor"), [idx]);
  // The floor of whatever is selected in the tree; else the first one.
  const selFloor = useMemo(() => (sel == null ? null : chain(idx, sel).reverse().find((n) => n.kind === "floor")?.id ?? null), [idx, sel]);
  const [chosen, setChosen] = useState<string | null>(null);
  const floor = chosen != null && floors.some((f) => String(f.node.id) === chosen) ? Number(chosen) : selFloor ?? floors[0]?.node.id ?? null;
  const [hot, setHot] = useState<string | null>(null);
  const { ask } = useDialog();
  const why = !shell.writable ? `${shell.director?.name ?? "This Director"} is read-only` : floor == null ? "The project has no floor to put a room on" : undefined;

  const add = async (template: string) => {
    if (why || floor == null) return;
    const taken = new Set(idx.get(floor)?.node.children.map((c) => c.name.toLowerCase()) ?? []);
    let name = template;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${template} ${n}`;
    const fl = idx.get(floor)?.node.name;
    const to = await ask({ title: `New room on “${fl}”`, initial: name, placeholder: "Room name", confirmLabel: "Propose room" });
    if (!to) return;
    const o = await shell.propose([{ op: "add_room", floor, name: to }], `Add the ${to} to ${fl}.`);
    const id = o?.status === "applied" ? o.created_item_ids[0] : undefined;
    if (id != null) onAdded(id);
  };

  return (
    <>
      <div className="filters loc-target">
        <span className="dim small">New rooms go on</span>
        {floors.length
          ? <Select value={floor != null ? String(floor) : ""} onValueChange={setChosen} label="Floor"
                    options={floors.map((f) => ({ value: String(f.node.id), label: f.location ? `${f.node.name} — ${f.location.split(" › ").pop()}` : f.node.name }))} />
          : <span className="dim small">no floor</span>}
      </div>
      <div className="panel-body tw loc" role="tree" aria-label="Location templates">
        {NOT_YET.map((g) => (
          <div key={g.title} className="loc-group off">
            <Tip text={`openComposer can add rooms only, for now — add ${g.title.toLowerCase()} in Composer Pro`} side="left">
              <div className="tw-row" aria-disabled><span className="tw-tw"><ChevronDown size={12} strokeWidth={1.8} /></span>
                <span className="tw-ic"><g.icon size={14} strokeWidth={1.8} /></span><span className="tw-label">{g.title}</span><span className="tw-meta">not yet</span></div>
            </Tip>
            {g.items.map((n) => (
              <div key={n} className="tw-row" style={{ paddingLeft: 26 }} aria-disabled>
                <span className="tw-ic"><g.icon size={13} strokeWidth={1.6} /></span><span className="tw-label">{n}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="loc-group">
          <div className="tw-row head"><span className="tw-tw"><ChevronDown size={12} strokeWidth={1.8} /></span>
            <span className="tw-ic"><DoorOpen size={14} strokeWidth={1.8} /></span><span className="tw-label">Rooms</span></div>
          {ROOMS.map(([n, Icon]) => (
            <div key={n} className={cx("tw-row loc-room", hot === n && "sel")} style={{ paddingLeft: 26 }} role="treeitem" tabIndex={0}
                 aria-selected={hot === n} onClick={() => setHot(n)} onDoubleClick={() => void add(n)}
                 onKeyDown={(e) => { if (e.key === "Enter") void add(n); }}>
              <span className="tw-ic"><Icon size={14} strokeWidth={1.7} /></span>
              <span className="tw-label">{n}</span>
              <Tip text={why ?? `Add a room on ${idx.get(floor!)?.node.name}`} side="left">
                <span className="spread"><button className="icon-btn loc-add" aria-label={`Add ${n}`} disabled={!!why}
                                                 onClick={(e) => { e.stopPropagation(); void add(n); }}><Plus size={13} strokeWidth={2} /></button></span>
              </Tip>
            </div>
          ))}
        </div>
        <p className="hint pad-t">Double-click a room, or use +, to propose it on the floor above. Renaming and moving rooms is in the tree's right-click menu.</p>
      </div>
    </>
  );
}
