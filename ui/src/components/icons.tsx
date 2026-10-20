/** Icons for what things are: project items by kind, devices and drivers by what they do.
 *
 *  A driver that carries its own icon (.c4z) is drawn with it (`DriverIcon`); everything else
 *  gets a generic icon guessed from its proxy type, its category or its file name — never a
 *  broken image. */

import {
  AudioLines, Bell, Blinds, Box, Building2, CalendarClock, Cctv, Clapperboard, Cpu, Disc3, DoorOpen, Fan, Home, Keyboard, Layers,
  Lightbulb, LockKeyhole, MapPin, Megaphone, Music, Projector, Radio, Satellite, Server, ShieldCheck, Speaker, TabletSmartphone,
  Thermometer, ToggleLeft, Tv, Waves, Workflow, type LucideIcon,
} from "lucide-react";
import type { ItemKind, KindLabel } from "../api";
import { useDriverIcon } from "../lib/driverIcons";
import { cx } from "../lib/ui";

/** Control4 proxy names (and the categories drivers are filed under) → what they look like. */
const BY_PROXY: [RegExp, LucideIcon][] = [
  [/^(controller|director)|controller$/i, Server],
  [/projector/i, Projector],
  [/^tv$|television|^video/i, Tv],
  [/receiver|avswitch|amplifier|^amp/i, Speaker],
  [/audio|digital_audio|music/i, Music],
  [/media_player|media_service|^media/i, Clapperboard],
  [/dvd|blu.?ray|disc/i, Disc3],
  [/satellite|cable/i, Satellite],
  [/tuner|radio/i, Radio],
  [/light|dimmer|lighting/i, Lightbulb],
  [/keypad/i, Keyboard],
  [/thermostat|hvac|comfort|climate/i, Thermometer],
  [/camera|cctv|surveillance/i, Cctv],
  [/intercom|doorbell|door_station/i, Bell],
  [/security|alarm/i, ShieldCheck],
  [/lock/i, LockKeyhole],
  [/blind|shade|motorization/i, Blinds],
  [/fan/i, Fan],
  [/pool|spa/i, Waves],
  [/relay|contact|sensor/i, ToggleLeft],
  [/uidevice|remote|touch|navigator/i, TabletSmartphone],
  [/scheduler/i, CalendarClock],
  [/announcement/i, Megaphone],
  [/agent/i, Workflow],
];

/** What a device is, guessed from its driver file — the tree has nothing else to go on, and a
 *  row of identical chips is how a TV gets mistaken for its receiver. */
const BY_DRIVER: [RegExp, LucideIcon][] = [
  [/projector|epson|jvc_|sony_vpl/i, Projector],
  [/apple_tv|roku|kaleidescape|media_player|shield/i, Clapperboard],
  [/tv|bravia|webos|tizen|oled/i, Tv],
  [/avr|receiver|anthem|denon|marantz|amp/i, Speaker],
  [/sonos|audio/i, AudioLines],
  [/dimmer|light|switch|lutron/i, Lightbulb],
  [/keypad/i, Keyboard],
  [/thermostat|ecobee/i, Thermometer],
  [/door_station|intercom|ds2/i, Bell],
  [/camera/i, Cctv],
  [/controller|ea\d|core\d|ca\d/i, Server],
  [/scheduler/i, CalendarClock],
  [/announcement/i, Megaphone],
];

const BY_KIND: Record<KindLabel, LucideIcon> = {
  project: Home, site: MapPin, building: Building2, floor: Layers, room: DoorOpen,
  device: Cpu, proxy: Box, agent: Workflow, item: Box,
};

const first = (table: [RegExp, LucideIcon][], s: string | null | undefined) =>
  s ? table.find(([re]) => re.test(s))?.[1] : undefined;

/** A generic icon: by proxy type when it is known, then by driver file name, then by kind. */
export function iconFor(kind: KindLabel | ItemKind, driver?: string | null, proxy?: string | null): LucideIcon {
  const k: KindLabel = typeof kind === "string" ? kind : "item";
  if (k === "device" || k === "proxy" || k === "agent") {
    return first(BY_PROXY, proxy) ?? first(BY_DRIVER, driver) ?? BY_KIND[k];
  }
  return BY_KIND[k];
}

export function KindIcon({ kind, driver, proxy, size = 14 }: {
  kind: KindLabel | ItemKind; driver?: string | null; proxy?: string | null; size?: number;
}) {
  const Icon = iconFor(kind, driver, proxy);
  return <Icon size={size} strokeWidth={1.8} aria-hidden />;
}

/** A device or driver: its own icon when the driver carries one, else the generic one. */
export function DriverIcon({ driver, kind = "device", proxy, size = 16, className }: {
  driver: string | null | undefined;
  kind?: KindLabel | ItemKind;
  /** Primary proxy or category, for a better generic icon. */
  proxy?: string | null;
  size?: number;
  className?: string;
}) {
  const src = useDriverIcon(driver);
  if (src) return <img className={cx("drv-icon", className)} src={src} width={size} height={size} alt="" draggable={false} />;
  return <span className={cx("drv-icon generic", className)} style={{ width: size, height: size }}><KindIcon kind={kind} driver={driver} proxy={proxy} size={Math.round(size * 0.86)} /></span>;
}
