/** What can be connected to what, and the ops that connect and disconnect them. */

import type { ConnectionRow, Op, Peer } from "../api/types.ts";

/** Classes two connection definitions have in common. */
export const shared = (a: string[], b: string[]) => a.filter((c) => b.includes(c));

/** The other ends a connection could be joined to: the opposite role, a class in common, on
 *  another device. An input takes one provider, so only free inputs are offered for an output;
 *  an output can feed several inputs, so any output is offered for an input. */
export function candidates(rows: ConnectionRow[], from: ConnectionRow): ConnectionRow[] {
  return rows.filter((r) =>
    r.device.id !== from.device.id
    && r.connection.role !== from.connection.role
    && shared(r.connection.classes, from.connection.classes).length > 0
    && (r.connection.role === "output" || r.connection.connected_to.length === 0));
}

export function connectOp(a: ConnectionRow, b: ConnectionRow): Op {
  const [consumer, provider] = a.connection.role === "input" ? [a, b] : [b, a];
  return {
    op: "add_connection",
    consumer_device: consumer.device.id,
    consumer_binding: consumer.connection.id,
    provider_device: provider.device.id,
    provider_binding: provider.connection.id,
    class: shared(consumer.connection.classes, provider.connection.classes)[0],
    consumer_name: consumer.connection.name,
  };
}

/** Disconnect `peer` from the connection `id` of `device`, whichever side is the consumer. */
export function disconnectOp(device: number, id: number, role: "input" | "output", peer: Peer): Op {
  const [consumer_device, consumer_binding] = role === "input" ? [device, id] : [peer.device.id, peer.binding];
  return { op: "remove_connection", consumer_device, consumer_binding, class: peer.classes[0] ?? "" };
}

// ---- what a connection class is ---------------------------------------------------------------

/** The sub-groups of a connections table, in the order Composer lists them. */
export type ConnKind = "video" | "audio" | "control" | "network" | "room" | "proxy" | "other";
export const CONN_KINDS: { id: ConnKind; label: string }[] = [
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "control", label: "Control" },
  { id: "network", label: "Network" },
  { id: "room", label: "Room" },
  { id: "proxy", label: "Proxy" },
  { id: "other", label: "Other" },
];

/** The drawing for a class: a connector where there is one (components/icons.tsx `ConnIcon`). */
export type Glyph =
  | "hdmi" | "dvi" | "vga" | "rca" | "component" | "stereo" | "svideo" | "optical" | "fcoax" | "antenna" | "app" | "storage"
  | "ir" | "serial" | "relay" | "contact" | "zigbee" | "zwave" | "usb" | "button" | "lightlink" | "speaker" | "stream"
  | "ethernet" | "room-video" | "room-audio" | "volume" | "room" | "proxy" | "plug";

/** The colour a class is drawn in — a CSS token `--conn-<tone>` (styles/design.css). They echo
 *  the real connectors: yellow composite, orange coax, red optical, blue VGA, purple IR. */
export type Tone =
  | "hdmi" | "dvi" | "vga" | "composite" | "component" | "stereo" | "svideo" | "coax" | "optical" | "rf" | "app"
  | "ir" | "serial" | "relay" | "contact" | "zigbee" | "zwave" | "usb" | "speaker" | "stream" | "net" | "room" | "neutral";

export interface ClassLook { label: string; glyph: Glyph; tone: Tone; kind: ConnKind }

const LOOKS: Record<string, ClassLook> = {
  HDMI: { label: "HDMI", glyph: "hdmi", tone: "hdmi", kind: "video" },
  DVI: { label: "DVI", glyph: "dvi", tone: "dvi", kind: "video" },
  VGA: { label: "VGA", glyph: "vga", tone: "vga", kind: "video" },
  RGB: { label: "RGB", glyph: "vga", tone: "vga", kind: "video" },
  COMPOSITE: { label: "Composite", glyph: "rca", tone: "composite", kind: "video" },
  COMPONENT: { label: "Component", glyph: "component", tone: "component", kind: "video" },
  SVIDEO: { label: "S-Video", glyph: "svideo", tone: "svideo", kind: "video" },
  RF_CABLE: { label: "Cable TV", glyph: "fcoax", tone: "rf", kind: "video" },
  RF_UHF_VHF: { label: "UHF/VHF", glyph: "fcoax", tone: "rf", kind: "video" },
  RF_SATELLITE: { label: "Satellite", glyph: "fcoax", tone: "rf", kind: "video" },
  RF_MINI_APP: { label: "App", glyph: "app", tone: "app", kind: "video" },
  RF_SAMSUNG_TV_APP: { label: "TV app", glyph: "app", tone: "app", kind: "video" },
  DIGITAL_MEDIA_STORAGE: { label: "Media storage", glyph: "storage", tone: "neutral", kind: "video" },

  STEREO: { label: "Stereo", glyph: "stereo", tone: "stereo", kind: "audio" },
  DIGITAL_COAX: { label: "Coax digital", glyph: "rca", tone: "coax", kind: "audio" },
  DIGITAL_OPTICAL: { label: "Optical", glyph: "optical", tone: "optical", kind: "audio" },
  TOSLINK: { label: "Optical", glyph: "optical", tone: "optical", kind: "audio" },
  SPEAKER: { label: "Speaker", glyph: "speaker", tone: "speaker", kind: "audio" },
  DIGITAL_AUDIO_SERVER: { label: "Digital audio", glyph: "stream", tone: "stream", kind: "audio" },
  DIGITAL_AUDIO_CLIENT: { label: "Digital audio", glyph: "stream", tone: "stream", kind: "audio" },
  AUDIO_MEDIA_STORAGE: { label: "Media storage", glyph: "storage", tone: "neutral", kind: "audio" },
  RF_AM: { label: "AM", glyph: "antenna", tone: "rf", kind: "audio" },
  RF_FM: { label: "FM", glyph: "antenna", tone: "rf", kind: "audio" },
  RF_INTERNET: { label: "Internet radio", glyph: "stream", tone: "rf", kind: "audio" },

  IR_OUT: { label: "IR", glyph: "ir", tone: "ir", kind: "control" },
  IR_IN: { label: "IR in", glyph: "ir", tone: "ir", kind: "control" },
  RS_232: { label: "Serial", glyph: "serial", tone: "serial", kind: "control" },
  RS_485: { label: "RS-485", glyph: "serial", tone: "serial", kind: "control" },
  CONTROL_SERIAL: { label: "Serial", glyph: "serial", tone: "serial", kind: "control" },
  RELAY: { label: "Relay", glyph: "relay", tone: "relay", kind: "control" },
  CONTACT_SENSOR: { label: "Contact", glyph: "contact", tone: "contact", kind: "control" },
  ZIGBEE: { label: "Zigbee", glyph: "zigbee", tone: "zigbee", kind: "control" },
  ZWAVE_MANAGEMENT_LINK: { label: "Z-Wave", glyph: "zwave", tone: "zwave", kind: "control" },
  USB: { label: "USB", glyph: "usb", tone: "usb", kind: "control" },
  BUTTON_LINK: { label: "Button link", glyph: "button", tone: "neutral", kind: "control" },
  HUE_CIRCUIT: { label: "Hue circuit", glyph: "lightlink", tone: "neutral", kind: "control" },

  TCP: { label: "TCP", glyph: "ethernet", tone: "net", kind: "network" },
  UDP: { label: "UDP", glyph: "ethernet", tone: "net", kind: "network" },
  SSL: { label: "SSL", glyph: "ethernet", tone: "net", kind: "network" },
  ETHERNET: { label: "Ethernet", glyph: "ethernet", tone: "net", kind: "network" },

  VIDEO_SELECTION: { label: "Video end-point", glyph: "room-video", tone: "room", kind: "room" },
  AUDIO_SELECTION: { label: "Audio end-point", glyph: "room-audio", tone: "room", kind: "room" },
  AUDIO_VOLUME: { label: "Volume", glyph: "volume", tone: "room", kind: "room" },
  ONSCREEN_SELECTION: { label: "On-screen", glyph: "room-video", tone: "room", kind: "room" },
  TEMPERATURE: { label: "Temperature", glyph: "room", tone: "room", kind: "room" },
  TEMPERATURE_CONTROL: { label: "Temperature control", glyph: "room", tone: "room", kind: "room" },
  SECURITY_SYSTEM: { label: "Security", glyph: "room", tone: "room", kind: "room" },
};

/** Proxy bindings (Director's type 2): a driver joined to its proxy, named after the proxy. */
const PROXY = /^(TV|DVD|MEDIA_PLAYER|MediaService|LIGHT|LIGHT_V2|CAMERA|CONTROLLER|AVSWITCH|RECEIVER|TUNER|INTERCOM|UIBUTTON|UI_DEVICE|THERMOSTAT|BLIND|POOL|SECURITY_PANEL|DOOR_STATION|.*_PROXY)$/i;

/** LIGHT_V2 → "Light v2", but TV and DVD stay acronyms. */
const plain = (cls: string) => cls.split("_").filter(Boolean)
  .map((w, i) => ((w.length <= 3 && /^[A-Z]+$/.test(w)) || /[a-z]/.test(w) ? w : i ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(" ");

/** How a connection class is labelled, drawn and grouped. Unknown classes still get a label (their
 *  name, de-shouted) and a plain plug, so a driver's private class is never a blank. */
export function classLook(cls: string): ClassLook {
  const known = LOOKS[cls] ?? LOOKS[cls.toUpperCase()];
  if (known) return known;
  if (PROXY.test(cls)) return { label: plain(cls), glyph: "proxy", tone: "neutral", kind: "proxy" };
  if (/^(LUTRON|NEEO|MOUNT)/i.test(cls)) return { label: plain(cls), glyph: "button", tone: "neutral", kind: "control" };
  return { label: plain(cls), glyph: "plug", tone: "neutral", kind: "other" };
}

/** Director's connection types (`<connection><type>`), as seen in real projects. */
const DIRECTOR_TYPES: Record<number, ConnKind> = { 1: "control", 2: "proxy", 4: "network", 5: "video", 6: "audio", 7: "room" };

/** Which sub-group a connection sits in: Director's own type when the view carries it.
 *  Without it (mock data) it's read off the classes, where HDMI is the one class used for
 *  both audio and video, and Control4 numbers audio outputs 4000-4999. */
export function kindOf(def: { id: number; name: string; classes: string[]; type?: number }): ConnKind {
  const byType = def.type != null ? DIRECTOR_TYPES[def.type] : undefined;
  if (byType) return byType;
  if (def.id >= 6000 && def.id < 7000) return "network";
  const kinds = def.classes.map((c) => classLook(c).kind);
  const first = kinds.find((k) => k !== "other") ?? (def.id < 1000 ? "control" : def.id >= 7000 && def.id < 8000 ? "room" : def.id >= 5000 && def.id < 6000 ? "proxy" : "other");
  if (first === "video" && def.classes.every((c) => c === "HDMI") && ((def.id >= 4000 && def.id < 5000) || (/audio/i.test(def.name) && !/video/i.test(def.name)))) {
    return "audio";
  }
  return first;
}
