/** Icons for what things are: project items by kind, devices and drivers by what they do.
 *
 *  A driver that carries its own icon (.c4z) is drawn with it (`DriverIcon`); everything else
 *  gets a generic icon guessed from its proxy type, its category or its file name — never a
 *  broken image. */

import {
  AudioLines, AudioWaveform, Bell, Blinds, Box, Building2, CalendarClock, Cctv, Clapperboard, Cpu, Disc3, DoorOpen, Fan, Home, Keyboard, Layers,
  Lightbulb, LockKeyhole, MapPin, Megaphone, Music, Projector, Radio, Satellite, Server, ShieldCheck, Speaker, TabletSmartphone,
  Thermometer, ToggleLeft, Tv, Waves, Workflow, type LucideIcon,
  Cable, HardDrive, MonitorPlay, Usb, Volume2,
} from "lucide-react";
import type { ItemKind, KindLabel } from "../api";
import { classLook, type Glyph } from "../lib/connections";
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

// ---- connection classes ----------------------------------------------------------------------

/** Connector faces drawn on lucide's grid (24 units, round 1.8 strokes) so they sit beside its
 *  icons. Single-colour ones use `currentColor`; component and stereo carry their jack colours
 *  (`--conn-red`, `--conn-white`…, styles/design.css). Holes are cut in `--side`. */
const hole = (cx: number, cy: number, r = 1.2) => <circle cx={cx} cy={cy} r={r} fill="var(--side)" stroke="none" />;
const dot = (cx: number, cy: number, r = 1) => <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

const GLYPHS: Partial<Record<Glyph, React.ReactNode>> = {
  hdmi: <><path d="M3 8.5h18v3.4l-2.6 3.6H5.6L3 11.9z" /><path d="M7.5 11.6h9" /></>,
  dvi: <><path d="M3 8h14.5L20 10.5v3L17.5 16H3z" />{[6.5, 10, 13.5].flatMap((x) => [dot(x, 10.6), dot(x, 13.4)])}</>,
  vga: <><path d="M2.5 7.5h19l-2.2 9H4.7z" />{[6.5, 10, 14, 17.5].map((x) => dot(x, 10.4))}{[8.2, 12, 15.8].map((x) => dot(x, 13.5))}</>,
  serial: <><path d="M4.5 8h15l-2 8h-11z" />{[8.5, 12, 15.5].map((x) => dot(x, 10.7))}{[10.2, 13.8].map((x) => dot(x, 13.4))}</>,
  rca: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.4" fill="currentColor" stroke="none" />{hole(12, 12, 1.4)}</>,
  component: <>
    <circle cx="4.8" cy="12" r="3.7" fill="var(--conn-red)" stroke="none" />{hole(4.8, 12, 1)}
    <circle cx="12" cy="12" r="3.7" fill="var(--conn-green)" stroke="none" />{hole(12, 12, 1)}
    <circle cx="19.2" cy="12" r="3.7" fill="var(--conn-blue)" stroke="none" />{hole(19.2, 12, 1)}
  </>,
  stereo: <>
    <circle cx="7" cy="12" r="5" fill="var(--conn-red)" stroke="none" />{hole(7, 12, 1.3)}
    <circle cx="17" cy="12" r="4.4" fill="var(--conn-white)" stroke="var(--conn-white-line)" strokeWidth="1.2" />{hole(17, 12, 1.3)}
  </>,
  svideo: <><circle cx="12" cy="12" r="8.5" />{dot(9, 10, 1.15)}{dot(15, 10, 1.15)}{dot(8.2, 13.8, 1.15)}{dot(15.8, 13.8, 1.15)}<path d="M10.5 16.8h3" /></>,
  optical: <><path d="M6 4.5h12v11L14.5 19h-5L6 15.5z" /><circle cx="12" cy="11" r="2.5" fill="currentColor" stroke="none" /></>,
  fcoax: <><path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z" /><circle cx="12" cy="12" r="3.4" />{dot(12, 12, 1.2)}</>,
  antenna: <><path d="M12 11.5V20" /><path d="M8.5 20.5h7" /><path d="M12 11.5 6 3.5" /><path d="M12 11.5l6-8" />{dot(12, 11.5, 1.5)}</>,
  app: <><rect x="4" y="4" width="7" height="7" rx="1.6" /><rect x="13" y="4" width="7" height="7" rx="1.6" /><rect x="4" y="13" width="7" height="7" rx="1.6" /><rect x="13" y="13" width="7" height="7" rx="1.6" /></>,
  ir: <>
    <path d="M10 4h4v7a2 2 0 0 1-4 0z" fill="currentColor" fillOpacity=".25" /><path d="M12 13v7.5" />
    <path d="M16.6 5.5a4.6 4.6 0 0 1 0 6" /><path d="M19.4 3.5a8 8 0 0 1 0 10" />
    <path d="M7.4 5.5a4.6 4.6 0 0 0 0 6" /><path d="M4.6 3.5a8 8 0 0 0 0 10" />
  </>,
  relay: <><path d="M3 15.5h3.4" /><path d="M17.6 15.5H21" /><circle cx="8" cy="15.5" r="1.6" /><circle cx="16" cy="15.5" r="1.6" /><path d="M9.3 14.5 16.5 9" /></>,
  contact: <><rect x="3.5" y="7" width="6.5" height="10" rx="1.2" /><rect x="14" y="7" width="6.5" height="10" rx="1.2" fill="currentColor" fillOpacity=".25" /><path d="M11.3 12h1.4" /></>,
  zigbee: <><circle cx="12" cy="12" r="8.5" /><path d="M8.3 8.5h7.4l-7.4 7h7.4" /></>,
  zwave: <><path d="M4 8.5h7.5l-7.5 7h7.5" /><path d="M15.5 9.3a3.8 3.8 0 0 1 0 5.4" /><path d="M18.4 6.8a7.4 7.4 0 0 1 0 10.4" /></>,
  button: <><rect x="3.5" y="6" width="17" height="12" rx="3" /><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" /></>,
  speaker: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="M15.5 9a4.2 4.2 0 0 1 0 6" /><path d="M18.4 6.5a7.8 7.8 0 0 1 0 11" /></>,
  ethernet: <><path d="M4 5.5h16v10.5h-4v3H8v-3H4z" /><path d="M8 9v2.4M10.7 9v2.4M13.3 9v2.4M16 9v2.4" /></>,
};

/** Glyphs that are fine as lucide's own icons. */
const LUCIDE: Partial<Record<Glyph, LucideIcon>> = {
  storage: HardDrive, usb: Usb, lightlink: Lightbulb, stream: AudioWaveform, "room-video": MonitorPlay, "room-audio": Music,
  volume: Volume2, room: DoorOpen, plug: Cable,
};

/** A connection class as an icon in its connector's colour (`.conn-ic` + `.ct-<tone>`). */
export function ConnIcon({ cls, size = 15 }: { cls: string; size?: number }) {
  const look = classLook(cls);
  const cls_ = cx("conn-ic", `ct-${look.tone}`);
  const drawn = GLYPHS[look.glyph];
  if (drawn) {
    return (
      <svg className={cls_} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
           strokeLinecap="round" strokeLinejoin="round" aria-hidden>{drawn}</svg>
    );
  }
  const Icon = look.glyph === "proxy" ? iconFor("proxy", null, cls) : LUCIDE[look.glyph] ?? Cable;
  return <Icon className={cls_} size={size} strokeWidth={1.8} aria-hidden />;
}

/** A connection class as a chip: its connector, its name; the raw class on hover. */
export function ConnChip({ cls, title }: { cls: string; title?: string }) {
  const look = classLook(cls);
  return (
    <span className={cx("chip conn", `ct-${look.tone}`)} title={title ?? cls}>
      <ConnIcon cls={cls} size={13} />{look.label}
    </span>
  );
}
