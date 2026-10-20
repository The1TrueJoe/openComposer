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
  label: string | null;
  fingerprint: string | null;
  error: string | null;
}

export interface McpStatus {
  listening: boolean;
  url: string;
  lan: boolean;
  error: string | null;
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
}

// ---- project views (app/src/views.rs) --------------------------------------------------------

export type KindLabel = "project" | "site" | "building" | "floor" | "room" | "device" | "proxy" | "agent" | "item";

export interface TreeNode {
  id: number;
  name: string;
  kind: KindLabel;
  driver: string | null;
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
}

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
  } | null;
  properties: PropertyView[];
  actions: { name: string; command: string }[] | null;
  connections: ConnectionDef[];
  network: NetworkBinding[];
  /** The driver's network connections (type 4, ids 6000-6999): what identify binds. */
  network_connections: { id: number; name: string; classes: string[] }[];
  variables: Variable[];
  events: { id: number; name: string; programming: CodeLineView[] }[];
  children: { id: number; name: string; kind: KindLabel; driver: string | null; connections: ConnectionDef[] }[];
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

export interface DriverStatus {
  filename: string;
  installed: boolean;
  /** What the controller's web API says about the file; its shape is the controller's. */
  info: Record<string, unknown> | null;
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
  | { kind: "programming_changed"; owner: ItemRef; event: number; event_name: string | null; lines: CodeLine[] };

export interface Diff {
  changes: Change[];
  summary: { added: number; removed: number; changed: number };
}

// ---- ops (crates/c4/src/ops.rs) ----------------------------------------------------------------

export type Op =
  | { op: "add_device"; room: number; name: string; driver: string }
  | { op: "add_room"; floor: number; name: string }
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

export interface ConversationInfo {
  id: string;
  provider: Provider;
  title: string;
  created: string;
  busy: boolean;
  entries: Entry[];
  cost_usd: number;
}

export interface ProviderStatus {
  provider: Provider;
  installed: boolean;
  path: string | null;
  version: string | null;
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
}
