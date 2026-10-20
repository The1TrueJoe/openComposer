import {
  Box, Building2, CalendarClock, Clapperboard, Cpu, DoorOpen, Home, Keyboard, Layers, Lightbulb, MapPin, Megaphone,
  Projector, Server, Speaker, Thermometer, Tv, Workflow, type LucideIcon,
} from "lucide-react";
import type { ItemKind, KindLabel } from "../api";

/** What a device is, guessed from its driver file — the tree has nothing else to go on, and a
 *  row of identical chips is how a TV gets mistaken for its receiver. */
const BY_DRIVER: [RegExp, LucideIcon][] = [
  [/projector|epson|jvc_|sony_vpl/i, Projector],
  [/tv|bravia|webos|tizen|oled/i, Tv],
  [/avr|receiver|anthem|denon|marantz|sonos|amp/i, Speaker],
  [/apple_tv|roku|kaleidescape|media_player|shield/i, Clapperboard],
  [/dimmer|light|switch|lutron/i, Lightbulb],
  [/keypad/i, Keyboard],
  [/thermostat|ecobee/i, Thermometer],
  [/controller|ea\d|core\d|ca\d/i, Server],
  [/scheduler/i, CalendarClock],
  [/announcement/i, Megaphone],
];

const BY_KIND: Record<KindLabel, LucideIcon> = {
  project: Home, site: MapPin, building: Building2, floor: Layers, room: DoorOpen,
  device: Cpu, proxy: Box, agent: Workflow, item: Box,
};

export function iconFor(kind: KindLabel | ItemKind, driver?: string | null): LucideIcon {
  const k: KindLabel = typeof kind === "string" ? kind : "item";
  if ((k === "device" || k === "proxy" || k === "agent") && driver) {
    for (const [re, icon] of BY_DRIVER) if (re.test(driver)) return icon;
  }
  return BY_KIND[k];
}

export function KindIcon({ kind, driver, size = 14 }: { kind: KindLabel | ItemKind; driver?: string | null; size?: number }) {
  const Icon = iconFor(kind, driver);
  return <Icon size={size} strokeWidth={1.8} aria-hidden />;
}
