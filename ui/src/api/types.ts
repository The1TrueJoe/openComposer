// Every shape the backend answers with. Mirrors app/src/*.rs and crates/c4/src/{diff,ops}.rs;
// field names are serde's, so snake_case throughout.

// ---- settings ------------------------------------------------------------------------------

export type AccessMode = "read_only" | "approve";
export type Provider = "claude" | "codex";

export interface SavedDirector {
  id: string;
  name: string;
  host: string;
  /** SHA-256 of the controller's TLS certificate, pinned on first connect. */
  fingerprint: string | null;
  mode: AccessMode;
  /** Use the controller's web API (driver files: install, check, full backups). */
  web_api: boolean;
  /** When it isn't `host:443` — a Virtual Director serves it on 127.0.0.1:8443 of its own PC. */
  web_api_addr: string | null;
  web_api_fingerprint: string | null;
}

export interface Config {
  directors: SavedDirector[];
  active_director: string | null;
  mcp: { port: number; lan: boolean; token: string };
  agent: { provider: Provider; claude_path: string | null; codex_path: string | null; model: string | null };
}

export interface IdentityStatus {
  loaded: boolean;
  /** False while the stored certificate is being unlocked (macOS may be asking for keychain access). */
  unlocked: boolean;
  label: string | null;
  fingerprint: string | null;
  error: string | null;
}

export interface McpStatus {
  listening: boolean;
  url: string;
  lan: boolean;
  error: string | null;
  /** The port actually bound: the configured one, or a loopback fallback when it was taken. */
  port: number;
}

/** An MCP client asking to sign in through the browser (app/src/oauth.rs); the person
 *  approves it here. */
export interface AuthRequest {
  id: string;
  client_name: string;
  redirect_uri: string;
  /** Where the request came from, as the browser reached openComposer. */
  host: string;
}

/** An MCP client signed in that way: revocable. */
export interface McpGrant {
  id: string;
  client_name: string;
  created: string;
  last_used: string | null;
}

/** A driver's own web page (driver.xml `<tabs>`), served by openComposer on 127.0.0.1. */
export interface DriverTab {
  name: string;
  url: string;
}

export interface AppStatus {
  version: string;
  config: Config;
  identity: IdentityStatus;
  mcp: McpStatus;
  /** Ids of Directors with a live session. */
  connected: string[];
  /** This executable, for MCP clients that speak stdio (see `--mcp-stdio`). */
  stdio_command: string;
}

// ---- Directors -----------------------------------------------------------------------------

export interface DirectorInfo {
  host: string;
  name: string;
  uuid: string;
  device_id: number;
  version: string;
  verified_version: boolean;
  server_fingerprint: string;
}

/** The `director` event and the result of `connect_director` (which has `mode` too). */
export interface DirectorEvent {
  id: string;
  connected: boolean;
  info?: DirectorInfo;
}

export interface Announcement {
  kind: string;
  address: string;
  host: string;
  device_type: string;
  primary_proxy: string;
  proxies: string[];
  manufacturer: string;
  model: string;
  driver: string;
  config_url: string;
  max_age: number | null;
  headers: Record<string, string>;
  /** Controllers only: the Director's state from the controller itself ("connected" on
   *  the primary, "disabled" on secondaries); null if it didn't say. */
  director?: string | null;
}

/** A Composer Pro remote-support session detected on this computer (app/src/actions.rs
 *  detect_sidecar / crates/c4/src/sidecar.rs). */
export interface SidecarSession {
  /** The virtual adapter's own IPv4 address (10.123.x.y). */
  adapter_ip: string;
  /** The interface it was found on. */
  interface: string;
  /** Address to add as a Director: `<adapter_ip>:5021`. */
  director_addr: string;
  /** Where the controller's web API is on the same relay. */
  web_api_addr: string;
  /** A Director answered on 5021 (a plain TCP probe). */
  reachable: boolean;
}

export interface SidecarDetection {
  detected: boolean;
  any_reachable: boolean;
  sessions: SidecarSession[];
  note: string;
}

// ---- project views (app/src/views.rs) --------------------------------------------------------

export type KindLabel = "project" | "site" | "building" | "floor" | "room" | "device" | "proxy" | "agent" | "item";

export interface TreeNode {
  id: number;
  /** For a device with one proxy, the proxy's name — the one the dealer gave it. */
  name: string;
  kind: KindLabel;
  driver: string | null;
  /** That proxy (folded into the device in the tree); renaming the device renames it. */
  proxy?: number | null;
  children: TreeNode[];
}

export interface Overview {
  project: string;
  counts: {
    rooms: number; devices: number; agents: number; connections: number;
    network_bindings: number; events_with_programming: number;
  };
  rooms: { id: number; name: string; location: string; devices: { id: number; name: string; driver: string | null }[] }[];
  agents: { id: number; name: string; driver: string | null }[];
}

export interface ShortItem {
  id: number;
  name: string;
  kind?: KindLabel;
  driver?: string | null;
}

export interface Peer {
  device: ShortItem;
  binding: number;
  connection: string | null;
  classes: string[];
}

export interface ConnectionDef {
  id: number;
  name: string;
  role: "input" | "output";
  /** Director's connection type: 1 control, 2 proxy, 4 network, 5 video, 6 audio, 7 room. */
  type?: number;
  classes: string[];
  connected_to: Peer[];
}

export interface PropertyView {
  name: string;
  value: string;
  type?: string;
  readonly?: boolean;
  options?: string[];
  min?: string | null;
  max?: string | null;
}

export interface NetworkBinding {
  device: number;
  binding: number;
  /** 1 = IP/SDDP, 3 = Zigbee. */
  address_type: number;
  address: string;
  uuid: string;
  search_type: string;
  status: string;
}

export interface Variable {
  device: number;
  id: number;
  name: string;
  var_type: number;
  readonly: boolean;
  hidden: boolean;
  description: string;
  value: string;
}

export interface CodeLineView {
  depth: number;
  text: string;
  enabled: boolean;
  id: number;
  /** The device the line sends to or tests (app/src/views.rs `code_lines`); 0 for lines that
   *  aren't about a device. */
  target?: number;
  /** Director's code item type: 1 command, 2 If, 3 While, 4 Else, 5 comment, 6 AND/OR. */
  kind?: number;
  /** What the line is (crates/c4/src/program.rs `role`). */
  role?: LineRole;
  /** The line's template as stored (NAME for the target), its command and parameters — what
   *  `add_code` needs to put the same line somewhere else. */
  display?: string;
  command?: string | null;
  params?: { name: string; type: string; value: string }[];
}

export type LineRole = "command" | "if" | "while" | "else" | "comment" | "delay" | "stop" | "break" | "variable" | "operator";

export type Logic = "equal" | "not_equal" | "less_than" | "less_than_or_equal" | "greater_than" | "greater_than_or_equal";

/** What an If or While can test on a device (app/src/views.rs `conditionals`). */
export interface ConditionalView {
  id: number | null;
  name: string;
  /** SIMPLE, BOOL, NUMBER, STRING, LIST, ROOM, DEVICE; empty for Control4's built-in proxies. */
  type: string;
  /** The line template: NAME for the device, LOGIC for the comparison. */
  description: string;
  statement: string;
  /** The comparisons it takes; empty when it takes none. */
  logic: Logic[];
  params: ParamDef[];
  /** Why openComposer can't add it, when it can't. */
  unsupported: string | null;
}

/** `get_variables` (app/src/views.rs `variables`). */
export interface VariableRow {
  device: number;
  id: number;
  name: string;
  owner: string;
  type: number;
  type_name: string;
  readonly: boolean;
  hidden: boolean;
  value: string;
  /** Whether openComposer can write lines for its type (String, Number, Float, Boolean). */
  programmable: boolean;
}

export interface VarRef { device: number; id: number }

/** What an If or While tests (crates/c4/src/program.rs `Condition`). */
export type Condition =
  | { type: "device"; target: number; name: string; logic?: Logic | null; params?: CommandParam[] }
  | { type: "variable"; variable: VarRef; logic: Logic; value?: string | null; other?: VarRef | null };

export type Control = { type: "delay"; ms: number } | { type: "stop" } | { type: "break" } | { type: "comment"; text: string };

export type VarAction =
  | { type: "set"; value: string } | { type: "copy"; from: VarRef } | { type: "toggle" }
  | { type: "add" | "subtract" | "multiply" | "divide"; value: string } | { type: "random"; min: string; max: string };

export interface ItemDetail {
  id: number;
  name: string;
  kind: KindLabel;
  path: string;
  room: string | null;
  driver: string | null;
  device: {
    manufacturer: string; model: string; driver_name: string; version: string;
    control_method: string; search_type: string; proxies: string[];
    /** `<capabilities>` as declared, e.g. `supports_color: "True"`. */
    capabilities?: Record<string, string> | null;
  } | null;
  /** The device's only proxy, which holds its name; null otherwise. */
  proxy?: number | null;
  /** The driver's own name for the device, when `name` is its proxy's. */
  driver_title?: string | null;
  properties: PropertyView[];
  actions: { name: string; command: string }[] | null;
  connections: ConnectionDef[];
  network: NetworkBinding[];
  /** The driver's network connections (type 4, ids 6000-6999): what identify binds. */
  network_connections: { id: number; name: string; classes: string[] }[];
  variables: Variable[];
  events: { id: number; /** The proxy, for a device shown with its sole proxy's events. */ device?: number; name: string; programming: CodeLineView[] }[];
  /** What the driver says it can be sent (Composer's device-specific commands); null when the
   *  item has no driver definition. */
  commands: CommandDef[] | null;
  /** What an If or While can test on it; null when the item has no driver definition. */
  conditionals?: ConditionalView[] | null;
  children: { id: number; name: string; kind: KindLabel; driver: string | null; connections: ConnectionDef[] }[];
}

/** A command's parameter, declared like a property (crates/c4/src/director.rs `PropertyDef`). */
export interface ParamDef {
  name: string;
  prop_type: string;
  default: string | null;
  readonly: boolean;
  /** LIST options. */
  items: string[];
  minimum: string | null;
  maximum: string | null;
}

export interface CommandDef {
  name: string;
  /** Composer's line template; `NAME` stands for the device. */
  description: string;
  params: ParamDef[];
}

/** One parameter of a command being sent (crates/c4/src/ops.rs `CodeParam`). */
export interface CommandParam {
  name: string;
  /** STRING, INTEGER, … as the driver declares it; STRING when left out. */
  type?: string;
  value: string;
}

/** `device_state`: `variables` is GetVariablesByDevice as JSON (attributes prefixed with `@`,
 *  the value as `#text`), read through `lib/control.ts`. */
export interface DeviceState {
  device: number;
  variables: unknown;
}

export interface ConnectionRow {
  device: { id: number; name: string; room: string | null };
  connection: ConnectionDef;
}

export interface ProgrammingEvent {
  device: ShortItem;
  event: number;
  event_name: string | null;
  lines: CodeLineView[];
}

export interface NetworkView {
  identified: {
    device: { id: number; name: string; path: string };
    address_type: number; address: string; uuid: string; search_type: string; status: string;
  }[];
  discovered: PhysicalDevice[];
  discovered_not_in_project: PhysicalDevice[];
}

export interface PhysicalDevice {
  uuid: string;
  address: string;
  address_type: number;
  device_type: string;
}

export type ZigbeeQuery = "server" | "mesh" | "nodes" | "zaps";

export interface DriverDoc {
  filename: string;
  name: string;
  manufacturer: string;
  model: string;
  version: number | null;
  creator: string;
  control_method: string;
  certified: boolean;
  primary_proxy: string;
  proxies: string[];
  search_types: string[];
  connection_names: string[];
  connection_classes: string[];
  date_modified: string;
  md5: string;
}

export interface BackupInfo {
  file: string;
  path: string;
  project: string;
  created: string;
  source: string;
  director: string;
  size: number;
  drivers: number;
}

/** What `backup_project` answers: the new file, and which driver files couldn't be included. */
export interface BackupResult extends BackupInfo {
  drivers_missing: string[];
  /** Why driver files were left out altogether (e.g. the web API is off), if they were. */
  note: string | null;
}

/** One driver file installed on the controller, as its web API lists it (`controller_drivers`).
 *  The shape is the controller's own (camelCase), so every field but the file name is optional. */
export interface ControllerDriver {
  filename: string;
  name?: string;
  manufacturer?: string;
  model?: string;
  version?: string | number | null;
  searchTypes?: string[];
  /** Proxy names; some firmware lists objects with a `name` instead of strings. */
  proxies?: unknown[];
  primaryProxy?: string;
  isAgent?: boolean;
  isCombo?: boolean;
  md5sum?: string;
  created?: string;
  modified?: string;
  certified?: boolean;
  category?: string;
}

/** A driver file read from disk (crates/c4/src/drivers.rs `LocalDriver`). */
export interface LocalDriver {
  filename: string;
  name: string;
  manufacturer: string;
  model: string;
  version: number | null;
  creator: string;
  control_method: string;
  search_types: string[];
  proxies: string[];
  /** Network connection ids (type 4): what identifying the device binds. */
  network_bindings: number[];
  size: number;
}

/** A file in openComposer's driver library (app/src/library.rs). */
export interface LibraryDriver extends LocalDriver {
  path: string;
  /** `library`: openComposer's own folder; `composer`: Composer Pro's folders on this PC. */
  source: "library" | "composer";
}

/** `add_driver`: install the file if needed, add the device, optionally identify it — one approval. */
export interface AddDriverArgs {
  room: number;
  filename: string;
  name?: string;
  identify?: {
    /** A discovered physical device's `uuid`, or SDDP's `<Type>-<Host>`. */
    address: string;
    /** The SDDP type, e.g. `Denon:AVR-X2100W`. */
    search_type: string;
    address_type?: number;
    binding?: number;
  };
  reason?: string;
}

// ---- semantic diff (crates/c4/src/diff.rs) ---------------------------------------------------

/** `ItemKind` serialized by serde: a word, or `{ other: code }` for kinds we don't name. */
export type ItemKind = Exclude<KindLabel, "item"> | { other: number };

export interface ItemRef {
  id: number;
  name: string;
  item_kind: ItemKind;
  /** Where it lives, top-down, e.g. ["House", "Main", "Living"]. */
  location: string[];
}

export interface Endpoint {
  device: ItemRef;
  binding: number;
  connection: string | null;
}

export interface DiffConnection {
  consumer: Endpoint;
  provider: Endpoint;
  classes: string[];
}

export interface CodeLine {
  op: "same" | "added" | "removed";
  depth: number;
  text: string;
  enabled: boolean;
}

export type Change =
  | { kind: "item_added"; item: ItemRef; driver: string | null; descendants: number }
  | { kind: "item_removed"; item: ItemRef; driver: string | null; descendants: number }
  | { kind: "item_renamed"; item: ItemRef; from: string; to: string }
  | { kind: "item_moved"; item: ItemRef; from: string[]; to: string[] }
  | { kind: "driver_changed"; item: ItemRef; from: string | null; to: string | null }
  | { kind: "property_changed"; item: ItemRef; property: string; from: string | null; to: string | null }
  | { kind: "connection_added"; connection: DiffConnection }
  | { kind: "connection_removed"; connection: DiffConnection; cascade: boolean }
  | { kind: "network_added"; item: ItemRef; binding: number; address_type: number; address: string; uuid: string; search_type: string }
  | { kind: "network_removed"; item: ItemRef; binding: number; address_type: number; address: string; uuid: string; search_type: string; cascade: boolean }
  | { kind: "network_changed"; item: ItemRef; binding: number; field: string; from: string; to: string }
  | { kind: "variable_added"; owner: ItemRef; id: number; name: string; value: string }
  | { kind: "variable_removed"; owner: ItemRef; id: number; name: string; value: string; cascade: boolean }
  | { kind: "variable_changed"; owner: ItemRef; id: number; name: string; field: string; from: string; to: string }
  | { kind: "programming_changed"; owner: ItemRef; event: number; event_name: string | null; lines: CodeLine[] }
  /** A Scheduler event; `when` reads like "Every day at Sunset, from 2024-06-16". */
  | { kind: "schedule_added"; owner: ItemRef; id: number; name: string; when: string }
  | { kind: "schedule_removed"; owner: ItemRef; id: number; name: string; when: string; cascade: boolean }
  | { kind: "schedule_changed"; owner: ItemRef; id: number; name: string; field: string; from: string; to: string }
  /** Something another built-in agent keeps (a lighting scene, an announcement, a Wake/Sleep
   *  room, a notification); `details` are its settings as [setting, value]. */
  | { kind: "agent_record_added"; owner: ItemRef; what: string; id: number; name: string; details: [string, string][] }
  | { kind: "agent_record_removed"; owner: ItemRef; what: string; id: number; name: string; details: [string, string][]; cascade: boolean }
  /** One setting changed; "none" for a setting (a light in a scene) that was added or removed. */
  | { kind: "agent_record_changed"; owner: ItemRef; what: string; id: number; name: string; field: string; from: string; to: string };

export interface Diff {
  changes: Change[];
  summary: { added: number; removed: number; changed: number };
}

// ---- ops (crates/c4/src/ops.rs) ----------------------------------------------------------------

export type LocationKind = "site" | "building" | "floor";

export type Op =
  | { op: "add_device"; room: number; name: string; driver: string }
  | { op: "add_room"; floor: number; name: string }
  | { op: "add_location"; parent: number; kind: LocationKind; name: string }
  | { op: "remove_item"; id: number }
  | { op: "rename_item"; id: number; name: string }
  | { op: "move_item"; id: number; parent: number; before: number | null }
  | { op: "add_connection"; consumer_device: number; consumer_binding: number; provider_device: number;
      provider_binding: number; class: string; consumer_name: string }
  | { op: "remove_connection"; consumer_device: number; consumer_binding: number; class: string }
  | { op: "add_network_binding"; device: number; binding: number; address_type: number; address: string; search_type: string }
  | { op: "remove_network_binding"; device: number; binding: number }
  /** Checked against the driver's property schema before anyone is asked. */
  | { op: "set_property"; device: number; name: string; value: string }
  | { op: "run_action"; device: number; command: string }
  /** Sent at once from the app's own controls; approved like a change when an assistant asks. */
  | { op: "send_command"; device: number; command: string; params?: CommandParam[] }
  | { op: "add_code"; device: number; event: number; parent?: number; before?: number; target: number;
      command: string; params?: { name: string; type?: string; value: string }[]; display: string }
  | { op: "remove_code"; device: number; event: number; id: number }
  /** `display` is filled in by the backend when empty. */
  | { op: "add_conditional"; device: number; event: number; parent: number; before: number; loop: boolean; condition: Condition; display?: string }
  | { op: "add_else"; device: number; event: number; parent: number; before: number }
  | { op: "add_control"; device: number; event: number; parent: number; before: number; control: Control }
  | { op: "add_variable_command"; device: number; event: number; parent: number; before: number; variable: VarRef; action: VarAction; display?: string }
  | { op: "move_code"; device: number; event: number; id: number; parent: number; before: number }
  | { op: "set_code_enabled"; device: number; event: number; id: number; enabled: boolean }
  /** Scheduler events (Composer's Scheduler agent). Modify keeps the entry's creator/category. */
  | { op: "add_schedule_entry"; agent: number; entry: ScheduleSpec }
  | { op: "modify_schedule_entry"; agent: number; id: number; entry: ScheduleSpec; creator: number; category: string }
  | { op: "remove_schedule_entry"; agent: number; id: number }
  /** Other built-in agents (crates/c4/src/agent_ops.rs); ids come from `agent_view`. */
  | { op: "add_lighting_scene"; agent: number; name: string }
  | { op: "rename_lighting_scene"; agent: number; scene: number; name: string }
  | { op: "remove_lighting_scene"; agent: number; scene: number }
  /** Adds the light to the scene if it isn't in it; replaces its steps if it is. */
  | { op: "set_scene_light"; agent: number; scene: number; light: number; steps: LightStep[] }
  | { op: "remove_scene_light"; agent: number; scene: number; light: number }
  | { op: "add_announcement"; agent: number; announcement: AnnouncementSpec }
  | { op: "modify_announcement"; agent: number; id: number; announcement: AnnouncementSpec }
  | { op: "remove_announcement"; agent: number; id: number }
  | { op: "add_wake_sleep_room"; agent: number; room: number }
  | { op: "modify_wake_sleep_room"; agent: number; id: number; settings: WakeSleepSpec }
  | { op: "remove_wake_sleep_room"; agent: number; id: number }
  | { op: "add_push_notification"; agent: number; template: PushTemplateSpec }
  | { op: "modify_push_notification"; agent: number; id: number; template: PushTemplateSpec }
  | { op: "remove_push_notification"; agent: number; id: number }
  | { op: "add_email_template"; agent: number; template: EmailTemplateSpec }
  | { op: "modify_email_template"; agent: number; id: number; template: EmailTemplateSpec }
  | { op: "remove_email_template"; agent: number; id: number }
  /** Only ever produced by `install_driver`; the file's bytes are not serialized back. */
  | { op: "install_driver"; filename: string; source: string }
  /** Only ever produced by `load_backup`; the XML is not serialized back. */
  | { op: "load_project"; label: string };

// ---- approvals (app/src/approvals.rs) -----------------------------------------------------------

export type ApprovalStatus = "pending" | "denied" | "expired" | "applying" | "applied" | "failed";

export interface Verification {
  matched: number;
  missing: string[];
  side_effects: Diff;
}

export interface Approval {
  id: string;
  created: string;
  decided: string | null;
  director_id: string;
  director_name: string;
  project: string;
  source: string;
  reason: string | null;
  ops: Op[];
  descriptions: string[];
  diff: Diff;
  status: ApprovalStatus;
  note: string | null;
  error: string | null;
  applied: { created: number[]; notes: string[] }[];
  restore_point: string | null;
  verification: Verification | null;
}

/** What `propose_changes` / `load_backup` resolve with once a decision is made. */
export interface Outcome {
  status: ApprovalStatus;
  message: string;
  approval_id: string;
  changes: string[];
  created_item_ids: number[];
  restore_point: string | null;
  verification: { predicted_changes_seen: number; predicted_but_missing: string[]; other_changes_director_made: number } | null;
}

export interface Attention {
  kind: string;
  id: string;
  title: string | null;
}

// ---- activity and the agent ------------------------------------------------------------------

export interface Activity {
  seq: number;
  at: string;
  source: string;
  tool: string;
  summary: string;
  ok: boolean;
  ms: number;
}

export type Entry =
  | { role: "user"; text: string; at: string }
  | { role: "assistant"; text: string; streaming: boolean }
  | { role: "tool"; id: string; name: string; input: unknown; output: unknown | null; is_error: boolean }
  | { role: "status"; text: string }
  | { role: "error"; text: string };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ConversationInfo {
  id: string;
  provider: Provider;
  title: string;
  created: string;
  busy: boolean;
  entries: Entry[];
  cost_usd: number;
  /** Model alias or id; null = the CLI's default (or Settings › Agent's). */
  model: string | null;
  /** Claude's effort level; null = default. */
  effort: Effort | null;
  /** openComposer tools the CLI loaded when it started; null until it has. 0 means the chat
   *  can't see the project (the backend also pushes an error entry saying why). */
  tools: number | null;
}

export interface ProviderStatus {
  provider: Provider;
  installed: boolean;
  path: string | null;
  version: string | null;
}

// ---- the window and assistants (actions::ui_context / ui_show) -------------------------------

/** What the window shows, reported with `set_ui_context` so assistants can resolve "this". */
export interface UiContext {
  view: string;
  director: { id: string; name: string } | null;
  item: { id: number; name: string; kind: KindLabel; path: string } | null;
  inspector_tab: string | null;
}

/** `ui_show`: an assistant steering the window. Unknown values are ignored, not errors. */
export interface UiCommand {
  view?: string;
  item?: number;
  tab?: string;
  approvals: boolean;
}

/** Every event the backend emits, by name. */
export interface Events {
  approval: Approval;
  attention: Attention;
  activity: Activity;
  agent: ConversationInfo;
  config: Config;
  mcp: McpStatus;
  director: DirectorEvent;
  "project-changed": { director: string };
  backups: BackupInfo[];
  "ui-command": UiCommand;
  "mcp-auth": AuthRequest;
  "mcp-auth-decided": { id: string; approve: boolean };
  identity: { unlocked: boolean };
}

// ---- built-in agents' own views (app/src/agent_views.rs, crates/c4/src/agents.rs) --------------

export type Weekday = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
export type Frequency = "once" | "daily" | "weekly" | "monthly" | "yearly";
export type TimeBase = "clock" | "sunrise" | "sunset";
export type Nth = "first" | "second" | "third" | "fourth" | "last";

/** What can be set on a scheduled event (Composer's "Edit Entry" dialog). */
export interface ScheduleSpec {
  name: string;
  enabled: boolean;
  time_base: TimeBase;
  /** clock: minutes after midnight; sunrise/sunset: offset, negative = before. */
  minutes: number;
  randomize_minutes: number;
  /** YYYY-MM-DD */
  start_date: string;
  /** Start on the Nth weekday of the start date's month instead; no weekday with "last" = last day. */
  start_on: { nth: Nth; weekday: Weekday | null } | null;
  repeat: Frequency;
  every: number;
  days: Weekday[];
  end_date: string | null;
}

export interface NamedRef { id: number; name: string; room: string | null }

export interface ScheduleRow {
  id: number;
  name: string;
  enabled: boolean;
  locked: boolean;
  hidden: boolean;
  /** The agent that made it (Update Manager…); null for people's own. */
  creator: NamedRef | null;
  category: string;
  time: string;
  repeat: string;
  start: string;
  end: string | null;
  /** Controller-local `YYYY-MM-DDTHH:MM`; null when disabled or expired. */
  next: { at: string; timezone: string } | null;
  spec: ScheduleSpec;
  programming: CodeLineView[];
}

/** A white by colour temperature, or a colour by hue (0–359) and saturation (0–100). */
export type LightColor = { kelvin: number } | { hue: number; saturation: number };

/** One step of a light in an Advanced Lighting scene: after `delay_ms`, go to `level` (0–100)
 *  and/or `color`, ramping over `rate_ms`. null = leave it alone in this step. */
export interface LightStep { delay_ms: number; level: number | null; rate_ms: number; color: LightColor | null }

export interface LightingSceneView {
  id: number; name: string; active: boolean; ramp_capable: boolean;
  /** Its "(Toggle)" companion scene. */
  toggle: { id: number; name: string } | null;
  /** Programming lines under its events. */
  programmed: number;
  members: { device: NamedRef; steps: (LightStep & { text: string })[] }[];
}

export interface AnnouncementVolume { id: number; volume: number | null }

/** What add/modify_announcement take. An image or sound still containing "••••" keeps the
 *  current one's hidden login. */
export interface AnnouncementSpec {
  name: string; audio: string | null; text: string; image: string | null;
  display_seconds: number; ok_button: boolean;
  rooms: AnnouncementVolume[]; screens: number[]; touchscreen_audio: AnnouncementVolume[];
}

export interface AnnouncementView {
  id: number; name: string; audio: string | null; text: string | null; image: string | null;
  display_seconds: number; ok_button: boolean;
  rooms: { room: NamedRef; volume: number | null }[];
  screens: { device: NamedRef; onscreen: boolean | null }[];
  touchscreen_audio: { device: NamedRef; volume: number | null }[];
  programmed: number;
  spec: AnnouncementSpec;
}

/** A room's Wake/Sleep defaults. `visible`: offered on touchscreens; `enabled`: on by default. */
export interface WakeSleepSpec {
  /** HH:MM, 24-hour. */
  wake_time: string;
  /** Empty = every day. */
  wake_days: Weekday[];
  sleep_minutes: number;
  /** light 0 = all the room's lights. */
  lights: { visible: boolean; enabled: boolean; light: number; ramp_minutes: number };
  /** source 0 = the room's TV; item 0 = none. */
  media: { visible: boolean; enabled: boolean; source: number; kind: string; item: number; tv_only: boolean };
  /** blind 0 = all the room's blinds. */
  blinds: { visible: boolean; enabled: boolean; blind: number };
  /** Setpoint in °F whatever the display scale. */
  temperature: { visible: boolean; enabled: boolean; mode: string; setpoint_f: number };
}

export interface MediaChoice { id: number; name: string; kind: string }

export interface WakeSleepRoomView {
  id: number; room: NamedRef; settings: WakeSleepSpec;
  /** The ids resolved: "All lights in the room" for 0. */
  light: NamedRef; blind: NamedRef; source: string | null; item: string | null;
  sources: MediaChoice[]; items: MediaChoice[]; temperature_modes: string[];
}

export interface PushTemplateSpec {
  name: string; category: number; severity: number; subject: string; message: string; timestamp: boolean;
  attachments: { owner: number; id: number }[];
}

export interface EmailTemplateSpec { name: string; to: string; subject: string; body: string; timestamp: boolean }

export interface PushTemplateView {
  id: number; name: string; subject: string; message: string; timestamp: boolean;
  category: string | null; severity: string | null; attachments: NamedRef[]; spec: PushTemplateSpec;
}

export interface EmailTemplateView { id: number; name: string; subject: string; message: string; to: string; spec: EmailTemplateSpec }

export interface LightingData { scenes: LightingSceneView[]; lights: NamedRef[] }
export interface AnnouncementsData {
  announcements: AnnouncementView[]; rooms: NamedRef[]; screens: NamedRef[]; touchscreens: NamedRef[];
  /** Sound files other announcements use (the controller's list is only reachable over SMB). */
  sounds: string[]; display_seconds: number[];
}
export interface WakeSleepData { rooms: WakeSleepRoomView[]; available_rooms: NamedRef[]; hospitality: boolean; lights: NamedRef[]; blinds: NamedRef[] }
export interface PushData {
  templates: PushTemplateView[]; categories: { id: number; name: string }[]; severities: { id: number; name: string }[];
  attachment_providers: { owner: NamedRef; id: number; label: string }[];
}
export interface EmailData { templates: EmailTemplateView[] }

interface AgentViewBase { id: number; title: string; agent: { id: number; name: string } }
export type AgentView =
  | { id: number; view: null }
  | (AgentViewBase & { view: "scheduler"; data: { sun: { sunrise: string; sunset: string; timezone: string } | null; entries: ScheduleRow[] } })
  | (AgentViewBase & { view: "advanced_lighting"; data: LightingData })
  | (AgentViewBase & { view: "announcements"; data: AnnouncementsData })
  | (AgentViewBase & { view: "wake_sleep"; data: WakeSleepData })
  | (AgentViewBase & { view: "push_notification"; data: PushData })
  | (AgentViewBase & { view: "email_notification"; data: EmailData })
  /** Read-only: the touchscreens' photo screen saver. */
  | (AgentViewBase & { view: "screen_saver"; data: { device: NamedRef | null; picture_path: string; photo_seconds: number } });

// Controller takeover (SSH + cert swap). Params fields keep the Rust snake_case names
// serde reads; the UI gates the call behind a confirmation.
export interface TakeoverStatus {
  has_ca: boolean;
  ca_label: string | null;
  ca_cn: string | null;
}
export interface TakeoverParams {
  host: string;
  os_version: string;
  account_email?: string | null;
  account_password?: string | null;
  dealer_password?: string | null;
  mac?: string | null;
  reboot: boolean;
  /** Also set up the OS-4.2 MQTT bus (patch api.pem). Off unless asked. */
  mqtt?: boolean;
}
/** Undoing a takeover needs the same way back in; no cert is issued. */
export type RevertParams = Omit<TakeoverParams, "mqtt">;
export interface TakeoverReport {
  era: string;
  patched: string[];
  already_patched: string[];
  missing: string[];
  rebooted: boolean;
  /** Empty on a revert (no cert issued). */
  issued_cn: string;
  ca_label: string;
  mqtt_patched?: boolean;
}
