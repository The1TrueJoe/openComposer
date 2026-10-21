/** The house the browser-only mock backend serves (see `mock.ts`): a small project with an
 *  AV stack in the living room, a theater, lighting, a thermostat and two agents. Shaped like
 *  the backend's own model so the mock can derive every view from it the same way. */

import type {
  Approval, BackupInfo, SavedDirector, CodeLineView, CommandDef, ConversationInfo, DriverDoc, ItemKind, ItemRef, KindLabel, LibraryDriver, NetworkBinding, Variable,
} from "../api/types";

export interface MItem {
  id: number;
  name: string;
  kind: KindLabel;
  parent: number | null;
  children: number[];
  driver: string | null;
  properties: Record<string, string>;
}

export interface MPropDef {
  name: string;
  prop_type: string;
  default?: string;
  readonly?: boolean;
  items?: string[];
  minimum?: string;
  maximum?: string;
}

export interface MDevice {
  manufacturer: string;
  model: string;
  driver_name: string;
  version: string;
  control_method: string;
  search_type: string;
  proxies: string[];
  connections: { id: number; name: string; consumer: boolean; classes: string[] }[];
  events: Record<number, string>;
  properties: MPropDef[];
  actions: [string, string][];
  /** What the driver declares it can be sent; proxies without any fall back to Control4's
   *  standard proxy commands in the control panel (as the TV proxies here do). */
  commands?: CommandDef[];
}

export interface MBinding {
  consumer_device: number;
  consumer_binding: number;
  provider_device: number;
  provider_binding: number;
  consumer_name: string;
  classes: string[];
}

export interface MProject {
  name: string;
  items: Map<number, MItem>;
  catalog: Map<number, MDevice>;
  bindings: MBinding[];
  network: NetworkBinding[];
  variables: Variable[];
  programming: Map<string, CodeLineView[]>;
}

type Row = [id: number, name: string, kind: KindLabel, parent: number | null, driver: string | null, props?: Record<string, string>];

const ROWS: Row[] = [
  [1, "Telaak House", "project", null, null],
  [2, "Home", "site", 1, null],
  [3, "Main House", "building", 2, null],
  [4, "Main Floor", "floor", 3, null],
  [5, "Upstairs", "floor", 3, null],
  [10, "Living Room", "room", 4, "roomdevice.c4i"],
  [11, "Kitchen", "room", 4, "roomdevice.c4i"],
  [12, "Theater", "room", 4, "roomdevice.c4i"],
  [13, "Primary Bedroom", "room", 5, "roomdevice.c4i"],
  [20, "Living TV", "device", 10, "sony_bravia_ip.c4z", { "IP Address": "192.168.1.41", "Power On Delay (ms)": "2500", "PIN Code": "1234" }],
  [21, "Living TV", "proxy", 20, "tv.c4i"],
  [22, "Living Receiver", "device", 10, "denon_avr_x3800h.c4z", { "Volume Limit": "80", "Input Labels": "HDMI 1: Apple TV, HDMI 2: Unused" }],
  [23, "Living Receiver", "proxy", 22, "receiver.c4i"],
  [24, "Living Apple TV", "device", 10, "apple_tv_ip.c4z"],
  [25, "Living Apple TV", "proxy", 24, "media_player.c4i"],
  [30, "Kitchen Lights", "device", 11, "control4_dimmer_gen3.c4i", { "Ramp Rate (ms)": "750" }],
  [31, "Kitchen Lights", "proxy", 30, "light_v2.c4i"],
  [32, "Kitchen Keypad", "device", 11, "control4_keypad_dimmer.c4i"],
  [40, "Theater Projector", "device", 12, "epson_ls12000.c4z"],
  [41, "Theater Projector", "proxy", 40, "tv.c4i"],
  [42, "Theater Receiver", "device", 12, "anthem_mrx1140.c4z"],
  [43, "Theater Receiver", "proxy", 42, "receiver.c4i"],
  [44, "EA-5 Controller", "device", 12, "controller_ea5.c4i"],
  [50, "Bedroom Thermostat", "device", 13, "ecobee_thermostat.c4z", { "API Key": "sk-ecobee-91f2", "Scale": "Fahrenheit" }],
  [51, "Bedroom Thermostat", "proxy", 50, "thermostatV2.c4i"],
  [52, "Bedroom TV", "device", 13, "lg_webos_tv.c4z"],
  [53, "Bedroom TV", "proxy", 52, "tv.c4i"],
  [90, "Scheduler", "agent", 1, "control4_agent_scheduler.c4i"],
  [91, "Announcements", "agent", 1, "control4_agent_announcement.c4i"],
];

const hdmiIn = (id: number, name: string) => ({ id, name, consumer: true, classes: ["HDMI"] });
const hdmiOut = (id: number, name: string) => ({ id, name, consumer: false, classes: ["HDMI"] });
const ir = (id: number, name: string, consumer: boolean) => ({ id, name, consumer, classes: ["IR_OUT"] });

const DEBUG: MPropDef = { name: "Debug Mode", prop_type: "LIST", default: "Off", items: ["Off", "Print", "Log", "Print and Log"] };

const param = (name: string, prop_type: string, extra: Partial<CommandDef["params"][number]> = {}): CommandDef["params"][number] =>
  ({ name, prop_type, default: null, readonly: false, items: [], minimum: null, maximum: null, ...extra });
const cmd = (name: string, description: string, ...params: CommandDef["params"]): CommandDef => ({ name, description, params });
const POWER = [cmd("ON", "Turn on NAME"), cmd("OFF", "Turn off NAME")];
const level = (name: string) => param(name, "RANGED_INTEGER", { minimum: "0", maximum: "100" });

const LIGHT: CommandDef[] = [
  ...POWER, cmd("TOGGLE", "Toggle NAME"),
  cmd("SET_LEVEL", "Set NAME level to LEVEL", level("LEVEL")),
  cmd("RAMP_TO_LEVEL", "Ramp NAME to LEVEL over TIME ms", level("LEVEL"), param("TIME", "RANGED_INTEGER", { minimum: "0", maximum: "60000", default: "1000" })),
];
const RECEIVER = (inputs: string[]): CommandDef[] => [
  ...POWER,
  cmd("SET_VOLUME_LEVEL", "Set NAME volume to LEVEL", level("LEVEL")),
  cmd("PULSE_VOL_UP", "Volume up on NAME"), cmd("PULSE_VOL_DOWN", "Volume down on NAME"),
  cmd("MUTE_ON", "Mute NAME"), cmd("MUTE_OFF", "Unmute NAME"), cmd("MUTE_TOGGLE", "Toggle mute on NAME"),
  cmd("SET_INPUT", "Select input INPUT on NAME", param("INPUT", "LIST", { items: inputs })),
];

const CATALOG: [number, MDevice][] = [
  [20, {
    manufacturer: "Sony", model: "BRAVIA XR A95L", driver_name: "Sony BRAVIA IP", version: "2024.11.02",
    control_method: "IP", search_type: "c4:television:sony", proxies: ["tv"],
    connections: [hdmiIn(2000, "HDMI 1"), hdmiIn(2001, "HDMI 2"), hdmiIn(2002, "HDMI 3"),
      { id: 4000, name: "ARC Audio Out", consumer: false, classes: ["DIGITAL_COAX", "STEREO"] }],
    events: { 1: "On", 2: "Off", 3: "Input Changed" },
    properties: [
      { name: "IP Address", prop_type: "STRING" },
      { name: "Power On Delay (ms)", prop_type: "RANGED_INTEGER", minimum: "0", maximum: "10000", default: "2500" },
      { name: "Input Selection Mode", prop_type: "LIST", items: ["Direct", "Cycle"], default: "Direct" },
      { name: "PIN Code", prop_type: "STRING" },
      { name: "Driver Version", prop_type: "STRING", readonly: true, default: "2024.11.02" },
      { name: "Connected", prop_type: "STRING", readonly: true, default: "Yes" },
      DEBUG,
    ],
    actions: [["Discover", "DISCOVER"], ["Reboot TV", "REBOOT"]],
    commands: [
      cmd("SET_PICTURE_MODE", "Set NAME picture mode to MODE", param("MODE", "LIST", { items: ["Standard", "Vivid", "Cinema", "Custom"] })),
      cmd("SEND_IRCC", "Send IRCC code CODE to NAME", param("CODE", "STRING")),
    ],
  }],
  [21, { manufacturer: "Control4", model: "TV", driver_name: "TV", version: "1", control_method: "", search_type: "", proxies: [],
    connections: [{ id: 7000, name: "Video End-Point", consumer: false, classes: ["VIDEO_SELECTION"] }],
    events: {}, properties: [], actions: [],
    commands: [...POWER, cmd("SET_INPUT", "Select input INPUT on NAME", param("INPUT", "LIST", { items: ["HDMI 1", "HDMI 2", "HDMI 3"] }))] }],
  [22, {
    manufacturer: "Denon", model: "AVR-X3800H", driver_name: "Denon AVR-X3800H", version: "112",
    control_method: "IP", search_type: "c4:av_gen:denon:avr-x3800h", proxies: ["receiver", "receiver"],
    connections: [hdmiIn(3000, "HDMI IN 1"), hdmiIn(3001, "HDMI IN 2"), hdmiIn(3002, "HDMI IN 3"),
      hdmiOut(2000, "HDMI OUT"), ir(1, "IR", true)],
    events: { 1: "Power On", 2: "Power Off" },
    properties: [
      { name: "Volume Limit", prop_type: "RANGED_INTEGER", minimum: "0", maximum: "98", default: "80" },
      { name: "Zone 2 Enabled", prop_type: "LIST", items: ["True", "False"], default: "False" },
      { name: "Input Labels", prop_type: "STRING" },
      { name: "Password", prop_type: "STRING", default: "hunter2" },
      DEBUG,
    ],
    actions: [["Sync Zones", "SYNC_ZONES"]],
    commands: [
      cmd("SET_ECO_MODE", "Set NAME eco mode to MODE", param("MODE", "LIST", { items: ["On", "Auto", "Off"] })),
      cmd("SET_DIALOG_LEVEL", "Set NAME dialog level to DB dB", param("DB", "RANGED_FLOAT", { minimum: "-12", maximum: "12", default: "0" })),
    ],
  }],
  [23, { manufacturer: "Control4", model: "Receiver", driver_name: "Receiver", version: "1", control_method: "", search_type: "", proxies: [],
    connections: [{ id: 7001, name: "Audio End-Point", consumer: false, classes: ["AUDIO_SELECTION"] }],
    events: {}, properties: [], actions: [], commands: RECEIVER(["HDMI IN 1", "HDMI IN 2", "HDMI IN 3"]) }],
  [24, {
    manufacturer: "Apple", model: "Apple TV 4K", driver_name: "Apple TV (IP)", version: "31",
    control_method: "IP", search_type: "apple-tv", proxies: ["media_player"],
    connections: [hdmiOut(2000, "HDMI OUT"), ir(1, "IR Input", true)],
    events: { 1: "Playing", 2: "Paused" }, properties: [DEBUG], actions: [["Pair", "PAIR"]],
  }],
  [25, { manufacturer: "Control4", model: "Media Player", driver_name: "Media Player", version: "1", control_method: "", search_type: "", proxies: [],
    connections: [], events: {}, properties: [], actions: [],
    commands: [...POWER, cmd("PLAY", "Play on NAME"), cmd("PAUSE", "Pause NAME"), cmd("STOP", "Stop NAME"),
      cmd("SKIP_FWD", "Skip forward on NAME"), cmd("SKIP_REV", "Skip back on NAME")] }],
  [30, {
    manufacturer: "Control4", model: "C4-DIM-Gen3", driver_name: "Dimmer (Gen 3)", version: "1046",
    control_method: "ZigBee", search_type: "", proxies: ["light_v2"], connections: [],
    events: { 1: "On", 2: "Off" },
    properties: [{ name: "Ramp Rate (ms)", prop_type: "RANGED_INTEGER", minimum: "0", maximum: "10000", default: "500" },
      { name: "Max On Level", prop_type: "RANGED_INTEGER", minimum: "1", maximum: "100", default: "100" }],
    actions: [],
    commands: [cmd("SET_LED_COLOR", "Set NAME LED to COLOR", param("COLOR", "LIST", { items: ["Blue", "White", "Off"] }))],
  }],
  [31, { manufacturer: "Control4", model: "Light", driver_name: "Light V2", version: "1", control_method: "", search_type: "", proxies: [],
    connections: [], events: {}, properties: [], actions: [], commands: LIGHT }],
  [32, {
    manufacturer: "Control4", model: "C4-KD120", driver_name: "Keypad Dimmer", version: "1031",
    control_method: "ZigBee", search_type: "", proxies: ["keypad_proxy"], connections: [],
    events: { 1: "Button 1 Pressed", 2: "Button 1 Released", 3: "Button 2 Pressed", 4: "Button 3 Pressed" },
    properties: [{ name: "Top Button Color", prop_type: "COLOR_SELECTOR", default: "0,0,255" }], actions: [],
  }],
  [40, {
    manufacturer: "Epson", model: "LS12000", driver_name: "Epson LS12000", version: "7",
    control_method: "Serial", search_type: "", proxies: ["tv"],
    connections: [hdmiIn(2000, "HDMI 1"), { id: 6, name: "RS-232", consumer: true, classes: ["RS_232"] }],
    events: { 1: "Lamp On", 2: "Lamp Off" },
    properties: [{ name: "Warm-up Time (s)", prop_type: "RANGED_INTEGER", minimum: "0", maximum: "120", default: "45" }],
    actions: [],
  }],
  [42, {
    manufacturer: "Anthem", model: "MRX 1140", driver_name: "Anthem MRX", version: "205",
    control_method: "IP", search_type: "c4:av_gen:anthem", proxies: ["receiver"],
    connections: [hdmiIn(3000, "HDMI IN 1"), hdmiIn(3001, "HDMI IN 2"), hdmiOut(2000, "HDMI OUT 1")],
    events: {}, properties: [DEBUG], actions: [],
  }],
  [43, { manufacturer: "Control4", model: "Receiver", driver_name: "Receiver", version: "1", control_method: "", search_type: "", proxies: [],
    connections: [], events: {}, properties: [], actions: [], commands: RECEIVER(["HDMI IN 1", "HDMI IN 2"]) }],
  [44, {
    manufacturer: "Control4", model: "EA-5", driver_name: "EA-5 Controller", version: "3.4.3",
    control_method: "", search_type: "", proxies: [],
    connections: [ir(1, "IR 1", false), ir(2, "IR 2", false), ir(3, "IR 3", false), ir(4, "IR 4", false),
      { id: 5, name: "Serial 1", consumer: false, classes: ["RS_232"] }],
    events: {}, properties: [], actions: [],
  }],
  [50, {
    manufacturer: "ecobee", model: "Smart Thermostat Premium", driver_name: "ecobee Thermostat", version: "48",
    control_method: "IP", search_type: "c4:thermostat:ecobee", proxies: ["thermostatV2"], connections: [],
    events: { 1: "Temperature Changed", 2: "Mode Changed" },
    properties: [{ name: "API Key", prop_type: "STRING" }, { name: "Scale", prop_type: "LIST", items: ["Fahrenheit", "Celsius"] },
      { name: "Polling Interval (s)", prop_type: "RANGED_INTEGER", minimum: "15", maximum: "600", default: "60" }],
    actions: [["Refresh Token", "REFRESH"]],
  }],
  [51, { manufacturer: "Control4", model: "Thermostat", driver_name: "Thermostat V2", version: "1", control_method: "", search_type: "", proxies: [],
    connections: [], events: {}, properties: [], actions: [],
    commands: [
      cmd("SET_SETPOINT_HEAT", "Set NAME heat setpoint to SETPOINT", param("SETPOINT", "RANGED_INTEGER", { minimum: "45", maximum: "90" })),
      cmd("SET_SETPOINT_COOL", "Set NAME cool setpoint to SETPOINT", param("SETPOINT", "RANGED_INTEGER", { minimum: "55", maximum: "95" })),
      cmd("SET_MODE_HVAC", "Set NAME HVAC mode to MODE", param("MODE", "LIST", { items: ["Off", "Heat", "Cool", "Auto"] })),
    ] }],
  [52, {
    manufacturer: "LG", model: "OLED65C3", driver_name: "LG webOS TV", version: "19",
    control_method: "IP", search_type: "c4:television:lg", proxies: ["tv"],
    connections: [hdmiIn(2000, "HDMI 1"), ir(1, "IR", true)],
    events: { 1: "On", 2: "Off" }, properties: [DEBUG], actions: [],
  }],
  [90, { manufacturer: "Control4", model: "Scheduler", driver_name: "Scheduler", version: "1", control_method: "", search_type: "", proxies: [],
    connections: [], events: { 1: "Sunset", 2: "Sunrise", 3: "Weekday 6:30 AM" }, properties: [], actions: [] }],
  [91, { manufacturer: "Control4", model: "Announcements", driver_name: "Announcements", version: "1", control_method: "", search_type: "", proxies: [],
    connections: [], events: { 1: "Good Morning" }, properties: [], actions: [] }],
];

const BINDINGS: MBinding[] = [
  { provider_device: 24, provider_binding: 2000, consumer_device: 22, consumer_binding: 3000, consumer_name: "HDMI IN 1", classes: ["HDMI"] },
  { provider_device: 22, provider_binding: 2000, consumer_device: 20, consumer_binding: 2000, consumer_name: "HDMI 1", classes: ["HDMI"] },
  { provider_device: 44, provider_binding: 1, consumer_device: 22, consumer_binding: 1, consumer_name: "IR", classes: ["IR_OUT"] },
  { provider_device: 44, provider_binding: 3, consumer_device: 52, consumer_binding: 1, consumer_name: "IR", classes: ["IR_OUT"] },
  { provider_device: 42, provider_binding: 2000, consumer_device: 40, consumer_binding: 2000, consumer_name: "HDMI 1", classes: ["HDMI"] },
  { provider_device: 44, provider_binding: 5, consumer_device: 40, consumer_binding: 6, consumer_name: "RS-232", classes: ["RS_232"] },
];

const NETWORK: NetworkBinding[] = [
  { device: 20, binding: 6001, address_type: 1, address: "192.168.1.41", uuid: "sony-bravia-8f2a1c", search_type: "c4:television:sony", status: "online" },
  { device: 22, binding: 6001, address_type: 1, address: "192.168.1.42", uuid: "denon-avr-x3800h-0005cd", search_type: "c4:av_gen:denon:avr-x3800h", status: "online" },
  { device: 24, binding: 6001, address_type: 1, address: "192.168.1.43", uuid: "apple-tv-4k-a1b2", search_type: "apple-tv", status: "online" },
  { device: 30, binding: 0, address_type: 3, address: "000fff0000a1b2c3", uuid: "000fff0000a1b2c3", search_type: "", status: "online" },
  { device: 50, binding: 6001, address_type: 1, address: "192.168.1.60", uuid: "ecobee-511843", search_type: "c4:thermostat:ecobee", status: "offline" },
];

const v = (device: number, id: number, name: string, value: string): Variable =>
  ({ device, id, name, var_type: 1, readonly: true, hidden: false, description: "", value });

const VARIABLES: Variable[] = [
  v(20, 1000, "POWER_STATE", "On"), v(20, 1001, "CURRENT_INPUT", "HDMI 1"),
  v(22, 1000, "POWER_STATE", "On"), v(22, 1001, "VOLUME_LEVEL", "35"), v(22, 1002, "MUTE_STATE", "0"), v(22, 1003, "CURRENT_INPUT", "HDMI IN 1"),
  v(24, 1000, "POWER_STATE", "On"), v(24, 1001, "PLAY_STATE", "Paused"),
  v(40, 1000, "POWER_STATE", "Off"), v(42, 1000, "POWER_STATE", "Off"), v(42, 1001, "VOLUME_LEVEL", "40"), v(42, 1002, "MUTE_STATE", "0"),
  v(30, 1000, "LIGHT_LEVEL", "65"), v(30, 1001, "LIGHT_STATE", "1"),
  v(50, 1000, "TEMPERATURE_F", "71"), v(50, 1001, "HEAT_SETPOINT_F", "68"), v(50, 1002, "COOL_SETPOINT_F", "75"),
  v(50, 1003, "HVAC_MODE", "Auto"), v(52, 1000, "POWER_STATE", "On"),
];

let lineId = 500;
type Param = { name: string; type: string; value: string };
/** A device command line: what it targets, sends and with what (kind 1, like Director's). */
type Cmd = [target: number, command: string, params?: Param[]];
/** Lines as views.rs sends them: a command line carries its stored template (NAME for the
 *  target), command and parameters; `"flow"` marks a conditional (no command); lines with
 *  neither are left bare, like ones the backend can't read. */
const code = (...lines: [depth: number, text: string, what?: Cmd | "flow", enabled?: boolean][]): CodeLineView[] =>
  lines.map(([depth, text, what, enabled = true]) => {
    const base = { depth, text, enabled, id: lineId++ };
    if (what === "flow") return { ...base, kind: 2, target: 0, command: null, params: [] };
    if (!what) return base;
    const [target, command, params = []] = what;
    const name = ROWS.find((r) => r[0] === target)?.[1] ?? "";
    return { ...base, kind: 1, target, command, params, display: name ? text.replace(name, "NAME") : text };
  });
const P = (name: string, value: string, type = "INTEGER"): Param => ({ name, type, value });
const SELECT_APPLE_TV: Cmd = [10, "SELECT_VIDEO_DEVICE", [P("deviceid", "24")]];

const PROGRAMMING: [string, CodeLineView[]][] = [
  ["32:1", code([0, "Toggle Kitchen Lights", [31, "TOGGLE"]])],
  ["32:3", code([0, "If Living TV is On", "flow"], [1, "Turn off Living TV", [21, "OFF"]], [1, "Turn off Living Receiver", [23, "OFF"]],
    [0, "Else", "flow"], [1, "Select Living Apple TV in Living Room", SELECT_APPLE_TV])],
  ["90:1", code([0, "Ramp Kitchen Lights to 40% over 5 seconds", [31, "RAMP_TO_LEVEL", [P("LEVEL", "40"), P("TIME", "5000")]]],
    [0, "If Bedroom Thermostat Heat Setpoint < 68", "flow"],
    [1, "Set Bedroom Thermostat Heat Setpoint to 68", [51, "SET_SETPOINT_HEAT", [P("SETPOINT", "68")]], false])],
  ["90:3", code([0, "Set Bedroom Thermostat HVAC mode to Auto", [51, "SET_MODE_HVAC", [P("MODE", "Auto", "STRING")]]],
    [0, "Announce “Good morning” in Kitchen", [91, "EXECUTE_ANNOUNCEMENT", [P("ANNOUNCEMENT_ID", "1")]]],
    [0, "Wait 30 seconds", undefined, false], [0, "Ramp Kitchen Lights to 80%", [31, "RAMP_TO_LEVEL", [P("LEVEL", "80")]]])],
  ["20:1", code([0, "Ramp Kitchen Lights to 20%", [31, "RAMP_TO_LEVEL", [P("LEVEL", "20")]]],
    [0, "Select Living Apple TV in Living Room", SELECT_APPLE_TV])],
];

export function seedProject(): MProject {
  const items = new Map<number, MItem>();
  for (const [id, name, kind, parent, driver, props] of ROWS) {
    items.set(id, { id, name, kind, parent, children: [], driver, properties: { ...props } });
  }
  for (const it of items.values()) if (it.parent != null) items.get(it.parent)!.children.push(it.id);
  return {
    name: "Telaak House",
    items,
    catalog: new Map(CATALOG.map(([id, d]) => [id, structuredClone(d)])),
    bindings: structuredClone(BINDINGS),
    network: structuredClone(NETWORK),
    variables: structuredClone(VARIABLES),
    programming: new Map(structuredClone(PROGRAMMING)),
  };
}

// ---- around the project --------------------------------------------------------------------

export const DIRECTORS: SavedDirector[] = [
  { id: "d-telaak", name: "Telaak House EA-5", host: "192.168.1.10", fingerprint: "5f:1c:9a:e2:44:0b:8d:37", mode: "approve",
    web_api: true, web_api_addr: null, web_api_fingerprint: "91:0c:4e:aa:17:d3:62:5b" },
  { id: "d-cabin", name: "Lake Cabin CORE 3", host: "cabin-core3.local", fingerprint: null, mode: "read_only",
    web_api: false, web_api_addr: null, web_api_fingerprint: null },
];

const doc = (d: Partial<DriverDoc> & Pick<DriverDoc, "filename" | "name" | "manufacturer" | "model">): DriverDoc => ({
  version: 12, creator: d.manufacturer, control_method: "IP", certified: true, primary_proxy: "tv", proxies: ["tv"],
  search_types: [], connection_names: [], connection_classes: [], date_modified: "2026-08-14", md5: "", ...d,
});

export const DRIVERS: DriverDoc[] = [
  doc({ filename: "lg_webos_tv.c4z", name: "LG webOS TV", manufacturer: "LG", model: "OLED C3/G3/C4 series", search_types: ["c4:television:lg"],
    connection_names: ["HDMI 1", "HDMI 2", "HDMI 3", "HDMI 4", "IR"], connection_classes: ["HDMI", "IR_OUT"] }),
  doc({ filename: "sony_bravia_ip.c4z", name: "Sony BRAVIA IP", manufacturer: "Sony", model: "BRAVIA XR (2021+)", search_types: ["c4:television:sony"],
    connection_names: ["HDMI 1", "HDMI 2", "HDMI 3", "ARC Audio Out"], connection_classes: ["HDMI", "STEREO", "DIGITAL_COAX"] }),
  doc({ filename: "samsung_tizen_tv.c4z", name: "Samsung Tizen TV", manufacturer: "Samsung", model: "QN90 / S95 series", certified: false,
    search_types: ["c4:television:samsung"], connection_names: ["HDMI 1", "HDMI 2"], connection_classes: ["HDMI"] }),
  doc({ filename: "denon_avr_x3800h.c4z", name: "Denon AVR-X3800H", manufacturer: "Denon", model: "AVR-X3800H", primary_proxy: "receiver",
    proxies: ["receiver", "receiver", "tuner"], search_types: ["c4:av_gen:denon:avr-x3800h"],
    connection_names: ["HDMI IN 1", "HDMI IN 2", "HDMI OUT", "IR"], connection_classes: ["HDMI", "IR_OUT"] }),
  doc({ filename: "sonos_amp.c4z", name: "Sonos Amp", manufacturer: "Sonos", model: "Amp", creator: "Chowmain", primary_proxy: "media_player",
    proxies: ["media_player"], search_types: ["c4:av_gen:sonos"], connection_names: ["Line In", "Audio Out"], connection_classes: ["STEREO"] }),
  doc({ filename: "apple_tv_ip.c4z", name: "Apple TV (IP)", manufacturer: "Apple", model: "Apple TV 4K", primary_proxy: "media_player",
    proxies: ["media_player"], search_types: ["apple-tv"], connection_names: ["HDMI OUT", "IR Input"], connection_classes: ["HDMI", "IR_OUT"] }),
  doc({ filename: "epson_ls12000.c4z", name: "Epson LS12000", manufacturer: "Epson", model: "LS12000", control_method: "Serial",
    connection_names: ["HDMI 1", "RS-232"], connection_classes: ["HDMI", "RS_232"] }),
  doc({ filename: "anthem_mrx1140.c4z", name: "Anthem MRX", manufacturer: "Anthem", model: "MRX 540/740/1140", primary_proxy: "receiver",
    proxies: ["receiver"], search_types: ["c4:av_gen:anthem"], connection_names: ["HDMI IN 1", "HDMI OUT 1"], connection_classes: ["HDMI"] }),
  doc({ filename: "ecobee_thermostat.c4z", name: "ecobee Thermostat", manufacturer: "ecobee", model: "Smart Thermostat Premium",
    primary_proxy: "thermostatV2", proxies: ["thermostatV2"], search_types: ["c4:thermostat:ecobee"] }),
  doc({ filename: "lutron_caseta.c4z", name: "Lutron Caséta Bridge", manufacturer: "Lutron", model: "Smart Bridge Pro", creator: "Chowmain",
    certified: false, primary_proxy: "light_v2", proxies: ["light_v2"], search_types: ["c4:lutron:caseta"] }),
  doc({ filename: "control4_dimmer_gen3.c4i", name: "Dimmer (Gen 3)", manufacturer: "Control4", model: "C4-DIM-Gen3", control_method: "ZigBee",
    primary_proxy: "light_v2", proxies: ["light_v2"] }),
  doc({ filename: "ds2_door_station.c4z", name: "DS2 Door Station", manufacturer: "Control4", model: "C4-DS2", primary_proxy: "intercom",
    proxies: ["intercom", "camera"], search_types: ["c4:intercom:ds2"] }),
];

/** Driver files in the library on "this computer": two imported, one from Composer's folder. */
export function seedLibrary(): LibraryDriver[] {
  const from = (filename: string, source: LibraryDriver["source"]): LibraryDriver => {
    const d = DRIVERS.find((x) => x.filename === filename)!;
    return {
      filename, name: d.name, manufacturer: d.manufacturer, model: d.model, version: d.version, creator: d.creator,
      control_method: d.control_method, search_types: d.search_types, proxies: d.proxies, network_bindings: [6001], size: 184_320,
      path: source === "composer" ? `C:\\Users\\you\\Documents\\Control4\\Drivers\\${filename}`
        : `~/Library/Application Support/com.openComposer.openComposer/drivers/${filename}`,
      source,
    };
  };
  return [from("sonos_amp.c4z", "library"), from("lutron_caseta.c4z", "library"), from("ds2_door_station.c4z", "composer")];
}

/** What an SDDP scan of this LAN finds. */
export const SDDP = [
  { host: "sony-bravia-8f2a1c", address: "192.168.1.41", device_type: "c4:television:sony", manufacturer: "Sony", model: "XR-65A95L", driver: "sony_bravia_ip.c4z" },
  { host: "denon-avr-x3800h-0005cd", address: "192.168.1.42", device_type: "c4:av_gen:denon:avr-x3800h", manufacturer: "Denon", model: "AVR-X3800H", driver: "" },
  { host: "lg-webos-c3-77", address: "192.168.1.53", device_type: "c4:television:lg", manufacturer: "LG Electronics", model: "OLED65C3PUA", driver: "lg_webos_tv.c4z" },
  { host: "sonos-amp-living", address: "192.168.1.70", device_type: "c4:av_gen:sonos", manufacturer: "Sonos", model: "Amp", driver: "" },
  { host: "samsung-qn90-den", address: "192.168.1.81", device_type: "c4:television:samsung", manufacturer: "Samsung", model: "QN65QN90C", driver: "samsung_tizen_tv.c4z" },
  { host: "yamaha-rx-a6a-5c1e", address: "192.168.1.90", device_type: "c4:av_gen:yamaha:rx-a6a", manufacturer: "Yamaha", model: "RX-A6A", driver: "" },
  { host: "c4-ea5-000fff112233", address: "192.168.1.10", device_type: "c4:control4_ea5:C4-EA5", manufacturer: "Control4", model: "EA-5", driver: "" },
];

export const BACKUPS: BackupInfo[] = [
  { file: "Telaak House 2026-10-20 091412 before change.c4p", path: "~/Library/Application Support/com.openComposer.openComposer/backups/Telaak House 2026-10-20 091412 before change.c4p",
    project: "Telaak House", created: "10/20/2026 9:14:12 AM", source: "openComposer", director: "3.4.3.741215 (Telaak House EA-5)", size: 1_612_331, drivers: 0 },
  { file: "Telaak House 2026-10-19 174502 backup.c4p", path: "~/Library/Application Support/com.openComposer.openComposer/backups/Telaak House 2026-10-19 174502 backup.c4p",
    project: "Telaak House", created: "10/19/2026 5:45:02 PM", source: "openComposer", director: "3.4.3.741215 (Telaak House EA-5)", size: 1_598_870, drivers: 0 },
  { file: "Telaak House 2026-09-30 composer.c4p", path: "~/Documents/Telaak House 2026-09-30 composer.c4p",
    project: "Telaak House", created: "9/30/2026 2:03:44 PM", source: "Composer Pro 3.4.3", director: "3.4.3.741215", size: 18_402_119, drivers: 42 },
  { file: "Lake Cabin 2026-08-02 backup.c4p", path: "~/Library/Application Support/com.openComposer.openComposer/backups/Lake Cabin 2026-08-02 backup.c4p",
    project: "Lake Cabin", created: "8/2/2026 11:20:00 AM", source: "openComposer", director: "3.4.1.735110 (Lake Cabin CORE 3)", size: 702_115, drivers: 0 },
];

export const ZIGBEE: Record<string, unknown> = {
  server: { "@version": "4.1.2.70", channel: "25", pan_id: "0x4C2F", extended_pan_id: "000FFF0000F7A3D1", nodes: "6", zap_count: "1", state: "online" },
  mesh: { mesh: { "@id": "1", "@channel": "25", "@nodes": "6", leader: "EA-5 Controller", zap: { "@id": "000fff0000f7a3d1", "@name": "EA-5 Controller" } } },
  nodes: {
    node: [
      { "@id": "000fff0000a1b2c3", "@name": "Kitchen Lights", "@type": "Dimmer", "@parent": "000fff0000f7a3d1", "@lqi": "212", "@rssi": "-48", "@online": "true", "@firmware": "05.00.25" },
      { "@id": "000fff0000a1b2d4", "@name": "Kitchen Keypad", "@type": "Keypad Dimmer", "@parent": "000fff0000a1b2c3", "@lqi": "188", "@rssi": "-57", "@online": "true", "@firmware": "05.00.25" },
      { "@id": "000fff0000c90011", "@name": "Bedroom Switch", "@type": "Switch", "@parent": "000fff0000f7a3d1", "@lqi": "96", "@rssi": "-79", "@online": "true", "@firmware": "04.02.11" },
      { "@id": "000fff0000c90012", "@name": "Garage Sensor", "@type": "Contact Sensor", "@parent": "000fff0000c90011", "@lqi": "40", "@rssi": "-88", "@online": "false", "@firmware": "03.01.00" },
    ],
  },
  zaps: { zap: { "@id": "000fff0000f7a3d1", "@name": "EA-5 Controller", "@type": "primary", children: "3" } },
};

// ---- approvals already on the card stack ---------------------------------------------------

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ref = (id: number, name: string, kind: ItemKind, location: string[]): ItemRef =>
  ({ id, name, item_kind: kind, location });
const LIVING = ["Home", "Main House", "Main Floor", "Living Room"];
const THEATER = ["Home", "Main House", "Main Floor", "Theater"];
const BEDROOM = ["Home", "Main House", "Upstairs", "Primary Bedroom"];
const KITCHEN = ["Home", "Main House", "Main Floor", "Kitchen"];

/** A proposal from an outside MCP client whose diff has one of every kind of change. */
export function showcaseApproval(): Approval {
  const tv = ref(20, "Living TV", "device", LIVING);
  const avr = ref(22, "Living AVR", "device", LIVING);
  const atv = ref(24, "Living Apple TV", "device", THEATER);
  const oled = ref(1001, "Bedroom OLED", "device", BEDROOM);
  const oldTv = ref(52, "Bedroom TV", "device", BEDROOM);
  const ea5 = ref(44, "EA-5 Controller", "device", THEATER);
  const theaterRx = ref(42, "Theater Receiver", "device", THEATER);
  const thermo = ref(50, "Bedroom Thermostat", "device", BEDROOM);
  const keypad = ref(32, "Kitchen Keypad", "device", KITCHEN);
  return {
    id: "ap-showcase", created: ago(2), decided: null, director_id: "d-telaak", director_name: "Telaak House EA-5",
    project: "Telaak House", source: "MCP client",
    reason: "Move the Apple TV to the theater, replace the bedroom TV with the new OLED, and tidy up names.",
    ops: [
      { op: "rename_item", id: 22, name: "Living AVR" },
      { op: "move_item", id: 24, parent: 12, before: null },
      { op: "remove_item", id: 52 },
      { op: "add_device", room: 13, name: "Bedroom OLED", driver: "lg_webos_tv.c4z" },
      { op: "add_connection", consumer_device: 42, consumer_binding: 3000, provider_device: 24, provider_binding: 2000, class: "HDMI", consumer_name: "HDMI IN 1" },
      { op: "remove_connection", consumer_device: 22, consumer_binding: 3000, class: "HDMI" },
      { op: "add_network_binding", device: 20, binding: 6001, address_type: 1, address: "192.168.1.52", search_type: "c4:television:sony" },
    ],
    descriptions: [
      "Rename “Living Receiver” to “Living AVR”",
      "Move “Living Apple TV” to “Theater”",
      "Remove device “Bedroom TV”",
      "Add “Bedroom OLED” (lg_webos_tv.c4z) to “Primary Bedroom”",
      "Connect “Living Apple TV” #2000 → “Theater Receiver” #3000 (HDMI)",
      "Disconnect “Living AVR” #3000 (HDMI)",
      "Identify “Living TV” as c4:television:sony at 192.168.1.52",
    ],
    diff: {
      summary: { added: 4, removed: 5, changed: 10 },
      changes: [
        { kind: "item_added", item: oled, driver: "lg_webos_tv.c4z", descendants: 1 },
        { kind: "item_removed", item: oldTv, driver: "lg_webos_tv.c4z", descendants: 1 },
        { kind: "item_renamed", item: avr, from: "Living Receiver", to: "Living AVR" },
        { kind: "item_moved", item: atv, from: LIVING, to: THEATER },
        { kind: "driver_changed", item: ref(40, "Theater Projector", "device", THEATER), from: "epson_ls12000.c4z", to: "epson_ls12000_v2.c4z" },
        { kind: "property_changed", item: tv, property: "Power On Delay (ms)", from: "2500", to: "4000" },
        { kind: "property_changed", item: tv, property: "IP Address", from: "192.168.1.41", to: "192.168.1.52" },
        { kind: "property_changed", item: thermo, property: "API Key", from: "••••••", to: "••••••" },
        { kind: "property_changed", item: avr, property: "Input Labels", from: "HDMI 1: Apple TV, HDMI 2: Unused", to: "HDMI 1: Apple TV, HDMI 2: Kaleidescape Strato" },
        { kind: "connection_added", connection: { classes: ["HDMI"],
          provider: { device: atv, binding: 2000, connection: "HDMI OUT" }, consumer: { device: theaterRx, binding: 3000, connection: "HDMI IN 1" } } },
        { kind: "connection_removed", cascade: false, connection: { classes: ["HDMI"],
          provider: { device: atv, binding: 2000, connection: "HDMI OUT" }, consumer: { device: avr, binding: 3000, connection: "HDMI IN 1" } } },
        { kind: "connection_removed", cascade: true, connection: { classes: ["IR_OUT"],
          provider: { device: ea5, binding: 3, connection: "IR 3" }, consumer: { device: oldTv, binding: 1, connection: "IR" } } },
        { kind: "network_added", item: oled, binding: 6001, address_type: 1, address: "lg-webos-c3-77", uuid: "lg-webos-c3-77", search_type: "c4:television:lg" },
        { kind: "network_removed", item: oldTv, binding: 6001, address_type: 1, address: "192.168.1.53", uuid: "lg-webos-b9-55", search_type: "c4:television:lg", cascade: true },
        { kind: "network_changed", item: tv, binding: 6001, field: "address", from: "192.168.1.41", to: "192.168.1.52" },
        { kind: "variable_added", owner: oled, id: 1000, name: "POWER_STATE", value: "Off" },
        { kind: "variable_removed", owner: oldTv, id: 1000, name: "POWER_STATE", value: "On", cascade: true },
        { kind: "variable_changed", owner: thermo, id: 1001, name: "HEAT_SETPOINT_F", field: "name", from: "HEAT_SETPOINT", to: "HEAT_SETPOINT_F" },
        { kind: "programming_changed", owner: keypad, event: 3, event_name: "Button 2 Pressed", lines: [
          { op: "same", depth: 0, text: "If Living TV is On", enabled: true },
          { op: "same", depth: 1, text: "Turn off Living TV", enabled: true },
          { op: "removed", depth: 1, text: "Turn off Living Receiver", enabled: true },
          { op: "added", depth: 1, text: "Turn off Living AVR", enabled: true },
          { op: "same", depth: 0, text: "Else", enabled: true },
          { op: "removed", depth: 1, text: "Select Living Apple TV in Living Room", enabled: true },
          { op: "added", depth: 1, text: "Select Living Apple TV in Theater", enabled: true },
          { op: "added", depth: 1, text: "Ramp Kitchen Lights to 30%", enabled: false },
        ] },
      ],
    },
    status: "pending", note: null, error: null, applied: [], restore_point: null, verification: null,
  };
}

/** Earlier cards: one applied (with Director's own follow-ups), one declined, one refused. */
export function historyApprovals(): Approval[] {
  const ea5 = ref(44, "EA-5 Controller", "device", THEATER);
  const avr = ref(22, "Living Receiver", "device", LIVING);
  const base = { director_id: "d-telaak", director_name: "Telaak House EA-5", project: "Telaak House", note: null, error: null,
    applied: [], restore_point: null, verification: null };
  return [
    {
      ...base, id: "ap-applied", created: ago(48), decided: ago(47), source: "In-app agent",
      reason: "Control the living room receiver over IR from the controller.",
      ops: [{ op: "add_connection", consumer_device: 22, consumer_binding: 1, provider_device: 44, provider_binding: 1, class: "IR_OUT", consumer_name: "IR" }],
      descriptions: ["Connect “EA-5 Controller” #1 → “Living Receiver” #1 (IR_OUT)"],
      diff: { summary: { added: 1, removed: 0, changed: 0 }, changes: [
        { kind: "connection_added", connection: { classes: ["IR_OUT"], provider: { device: ea5, binding: 1, connection: "IR 1" }, consumer: { device: avr, binding: 1, connection: "IR" } } },
      ] },
      status: "applied", applied: [{ created: [], notes: [] }],
      restore_point: "~/Library/Application Support/com.openComposer.openComposer/backups/Telaak House 2026-10-20 091412 before change.c4p",
      verification: { matched: 1, missing: [], side_effects: { summary: { added: 0, removed: 0, changed: 0 }, changes: [
        { kind: "variable_added", owner: avr, id: 1010, name: "IR_EMITTER_MODE", value: "IR" },
        { kind: "property_changed", item: ea5, property: "IR 1 Mode", from: "Off", to: "IR" },
      ] } },
    },
    {
      ...base, id: "ap-denied", created: ago(130), decided: ago(128), source: "MCP client", reason: null,
      ops: [{ op: "add_room", floor: 5, name: "Office" }],
      descriptions: ["Add room “Office” to “Upstairs”"],
      diff: { summary: { added: 1, removed: 0, changed: 0 }, changes: [
        { kind: "item_added", item: ref(1002, "Office", "room", ["Home", "Main House", "Upstairs"]), driver: "roomdevice.c4i", descendants: 0 },
      ] },
      status: "denied", note: "Wrong floor — the office is on the main floor.",
    },
    {
      ...base, id: "ap-failed", created: ago(300), decided: ago(299), source: "You (openComposer)", reason: null,
      ops: [{ op: "add_device", room: 10, name: "Living Sonos", driver: "sonos_amp.c4z" }],
      descriptions: ["Add “Living Sonos” (sonos_amp.c4z) to “Living Room”"],
      diff: { summary: { added: 1, removed: 0, changed: 0 }, changes: [
        { kind: "item_added", item: ref(1003, "Living Sonos", "device", LIVING), driver: "sonos_amp.c4z", descendants: 1 },
      ] },
      status: "failed", error: "AddDevice: the driver file sonos_amp.c4z is not on the controller (add it with Composer's driver manager first)",
    },
  ];
}

// ---- the agent -----------------------------------------------------------------------------

/** The pending proposal the waiting conversation is blocked on. */
export function agentApproval(): Approval {
  const ea5 = ref(44, "EA-5 Controller", "device", THEATER);
  const tv = ref(52, "Bedroom TV", "device", BEDROOM);
  return {
    id: "ap-agent", created: ago(1), decided: null, director_id: "d-telaak", director_name: "Telaak House EA-5",
    project: "Telaak House", source: "In-app agent", reason: "Give the bedroom TV a second IR emitter for its input switching.",
    ops: [{ op: "add_connection", consumer_device: 52, consumer_binding: 1, provider_device: 44, provider_binding: 2, class: "IR_OUT", consumer_name: "IR" }],
    descriptions: ["Connect “EA-5 Controller” #2 → “Bedroom TV” #1 (IR_OUT)"],
    diff: { summary: { added: 1, removed: 1, changed: 0 }, changes: [
      { kind: "connection_removed", cascade: false, connection: { classes: ["IR_OUT"], provider: { device: ea5, binding: 3, connection: "IR 3" }, consumer: { device: tv, binding: 1, connection: "IR" } } },
      { kind: "connection_added", connection: { classes: ["IR_OUT"], provider: { device: ea5, binding: 2, connection: "IR 2" }, consumer: { device: tv, binding: 1, connection: "IR" } } },
    ] },
    status: "pending", note: null, error: null, applied: [], restore_point: null, verification: null,
  };
}

export function seedConversations(): ConversationInfo[] {
  return [
    {
      id: "c-ir", provider: "claude", title: "Move the bedroom TV to IR 2", created: ago(4), busy: true, cost_usd: 0.0412,
      model: "sonnet", effort: "high", tools: 17,
      entries: [
        { role: "status", text: "Connected to Claude (17 openComposer tools)." },
        { role: "user", text: "The bedroom TV is on IR 3 but that emitter is dead. Move it to IR 2.", at: ago(3) },
        { role: "tool", id: "t1", name: "find_items", input: { query: "Bedroom TV" }, is_error: false,
          output: { matches: [{ id: 52, name: "Bedroom TV", kind: "device", driver: "lg_webos_tv.c4z", path: "Home › Main House › Upstairs › Primary Bedroom › Bedroom TV" }] } },
        { role: "tool", id: "t2", name: "list_connections", input: { device: 44, class: "IR_OUT" }, is_error: false,
          output: { connections: [{ device: { id: 44, name: "EA-5 Controller", room: "Theater" }, connection: { id: 2, name: "IR 2", role: "output", classes: ["IR_OUT"], connected_to: [] } }] } },
        { role: "assistant", streaming: false,
          text: "**IR 2** on the EA-5 is free, and the Bedroom TV's `IR` input is currently on **IR 3**. Because an input can only take one emitter, I'll disconnect IR 3 and connect IR 2 in a single proposal." },
        { role: "tool", id: "t3", name: "propose_changes", is_error: false, output: null,
          input: { reason: "Give the bedroom TV a second IR emitter for its input switching.",
            ops: [{ op: "add_connection", consumer_device: 52, consumer_binding: 1, provider_device: 44, provider_binding: 2, class: "IR_OUT", consumer_name: "IR" }] } },
      ],
    },
    {
      id: "c-theater", provider: "claude", title: "What's in the theater?", created: ago(95), busy: false, cost_usd: 0.0187,
      model: "opus", effort: null, tools: 17,
      entries: [
        { role: "status", text: "Connected to Claude (17 openComposer tools)." },
        { role: "user", text: "What's in the theater and how is it wired?", at: ago(94) },
        { role: "tool", id: "t9", name: "get_item", input: { id: 12 }, is_error: false, output: { id: 12, name: "Theater", kind: "room", children: [40, 42, 44] } },
        { role: "tool", id: "t10", name: "director_read", input: { method: "SetVolume", params: {} }, is_error: true,
          output: "SetVolume is not a read (only Get*/Is* calls are allowed here)" },
        { role: "assistant", streaming: false, text: [
          "The **Theater** has three devices:",
          "",
          "| Device | Driver | Wired to |",
          "|---|---|---|",
          "| Theater Projector | `epson_ls12000.c4z` | HDMI 1 ← Theater Receiver · RS-232 ← EA-5 Serial 1 |",
          "| Theater Receiver | `anthem_mrx1140.c4z` | HDMI OUT 1 → Projector |",
          "| EA-5 Controller | `controller_ea5.c4i` | IR 1 → Living Receiver, IR 3 → Bedroom TV |",
          "",
          "Nothing feeds the receiver's **HDMI IN 1** yet — want me to connect a source?",
        ].join("\n") },
      ],
    },
    {
      // A chat whose CLI couldn't reach the MCP server: what the backend says, and what the UI
      // must make obvious (start a new chat).
      id: "c-notools", provider: "claude", title: "Which lights are on?", created: ago(200), busy: false, cost_usd: 0.0021,
      model: null, effort: null, tools: 0,
      entries: [
        { role: "error", text: "openComposer's tools didn't load, so this chat can't see the project (port 7710 is in use; external MCP clients can't connect until it's free). Check Settings → MCP, then start a new chat." },
        { role: "user", text: "Which lights are on?", at: ago(199) },
        { role: "assistant", streaming: false, text: "I don't have any tools to look at your project from here, so I can't tell which lights are on." },
      ],
    },
  ];
}
