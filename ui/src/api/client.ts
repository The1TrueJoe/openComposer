import type {
  Activity, Announcement, AppStatus, Approval, BackupInfo, ConnectionRow, ConversationInfo, Diff,
  DirectorInfo, DriverDoc, Events, ItemDetail, McpStatus, NetworkView, Op, Outcome, Overview,
  ProgrammingEvent, VariableRow, Provider, ProviderStatus, SavedDirector, AccessMode, TreeNode, ZigbeeQuery, BackupResult,
  AddDriverArgs, ControllerDriver, LibraryDriver, UiContext, CommandParam, DeviceState, Effort, AuthRequest, McpGrant, DriverTab, AgentView,
  TakeoverStatus, TakeoverParams, TakeoverReport, RevertParams, SidecarDetection, FoundCert,
} from "./types";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <K extends keyof Events>(event: K, handler: (payload: Events[K]) => void) => Promise<() => void>;

// Inside Tauri the real IPC; in a plain browser (`npm run dev` without the app) a fixture
// backend, so every screen can be built and looked at without a controller. Loaded lazily so
// the fixtures never reach the production bundle's first chunk.
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const backend: Promise<{ invoke: Invoke; listen: Listen }> = inTauri
  ? Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]).then(([core, event]) => ({
      invoke: core.invoke as Invoke,
      listen: (async (name, handler) => event.listen(name, (e) => handler(e.payload as never))) as Listen,
    }))
  : import("../lib/mock").then((m) => ({ invoke: m.invoke, listen: m.listen }));

export const isMock = !inTauri;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await backend).invoke<T>(cmd, args);
}

/** Subscribe to a backend event; resolves to the unsubscribe function. */
export async function on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void) {
  return (await backend).listen(event, handler);
}

/** Commands reject with the backend's own sentence; make sure that is what gets shown. */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}

// Project reads and writes all go through the one `action` command, named after the MCP tool
// they mirror. Arguments keep the Rust (snake_case) field names: serde reads them, not Tauri.
const action = <T>(name: string, args?: Record<string, unknown>) => call<T>("action", { name, args: args ?? null });

export interface ConnectionsFilter {
  device?: number;
  class?: string;
  unconnected_only?: boolean;
}

export const api = {
  status: () => call<AppStatus>("app_status"),
  importPem: (cert: string, key: string | null) => call<void>("import_identity_pem", { cert, key }),
  importP12: (path: string, password: string) => call<void>("import_identity_p12", { path, password }),
  /** Any picked/dropped certificate files; a .p12 without a password rejects with a message
   *  starting "NEEDS_PASSWORD:". */
  importFiles: (paths: string[], password: string | null = null) => call<void>("import_identity_files", { paths, password }),
  /** Client certificates found where Composer Pro keeps one, to reuse without exporting by hand. */
  discoverCerts: () => call<FoundCert[]>("discover_certs"),

  addDirector: (name: string, host: string, mode: AccessMode) => call<SavedDirector>("add_director", { name, host, mode }),
  updateDirector: (id: string, patch: { name?: string; host?: string; mode?: AccessMode; webApi?: boolean; webApiAddr?: string }) =>
    call<void>("update_director", { id, ...patch }),
  removeDirector: (id: string) => call<void>("remove_director", { id }),
  setActiveDirector: (id: string) => call<void>("set_active_director", { id }),
  forgetFingerprint: (id: string) => call<void>("forget_fingerprint", { id }),
  connect: (id: string) => call<{ id: string; mode: AccessMode; info: DirectorInfo }>("connect_director", { id }),
  disconnect: (id: string) => call<void>("disconnect_director", { id }),
  discoverControllers: () => call<Announcement[]>("discover_controllers"),

  approvals: () => call<Approval[]>("approvals"),
  decide: (id: string, approve: boolean, note?: string) => call<boolean>("decide_approval", { id, approve, note: note ?? null }),
  activity: () => call<Activity[]>("activity"),

  updateMcp: (p: { port?: number; lan?: boolean; newToken?: boolean }) => call<McpStatus>("update_mcp", p),
  updateAgent: (p: { provider?: Provider; claudePath?: string; codexPath?: string; model?: string }) => call<void>("update_agent", p),
  /** MCP clients waiting for the person to approve their sign-in. */
  mcpAuthPending: () => call<AuthRequest[]>("mcp_auth_pending"),
  mcpAuthDecide: (id: string, approve: boolean) => call<boolean>("mcp_auth_decide", { id, approve }),
  mcpGrants: () => call<McpGrant[]>("mcp_grants"),
  mcpRevoke: (id: string) => call<void>("mcp_revoke", { id }),
  agentProviders: () => call<ProviderStatus[]>("agent_providers"),
  agentList: () => call<ConversationInfo[]>("agent_list"),
  agentNew: (provider?: Provider, model?: string | null, effort?: Effort | null) =>
    call<ConversationInfo>("agent_new", { provider: provider ?? null, model: model || null, effort: effort || null }),
  /** Switch model/effort mid-conversation: the CLI restarts and resumes the same session. */
  agentConfigure: (id: string, model: string | null, effort: Effort | null) =>
    call<ConversationInfo>("agent_configure", { id, model: model || null, effort: effort || null }),
  /** `attachments` are absolute paths; the backend copies them where the agent may read them. */
  agentSend: (id: string, text: string, attachments: string[] = []) => call<void>("agent_send", { id, text, attachments }),
  agentStop: (id: string) => call<void>("agent_stop", { id }),
  agentDelete: (id: string) => call<void>("agent_delete", { id }),

  overview: () => action<Overview>("project_overview"),
  tree: () => action<{ tree: TreeNode | null; project: string }>("project_tree"),
  findItems: (query: string, kind?: string) =>
    action<{ matches: { id: number; name: string; kind: string; driver: string | null; path: string }[] }>("find_items", { query, kind }),
  item: (id: number) => action<ItemDetail>("get_item", { id }),
  connections: (f: ConnectionsFilter = {}) => action<{ connections: ConnectionRow[] }>("list_connections", { ...f }),
  programming: (device?: number) => action<{ events: ProgrammingEvent[] }>("get_programming", { device }),
  variables: (device?: number, hidden = false) => action<{ variables: VariableRow[] }>("get_variables", { device, hidden }),
  network: () => action<NetworkView>("network_status"),
  sddp: (seconds?: number, pattern?: string) => action<{ devices: Announcement[] }>("discover_sddp", { seconds, pattern }),
  /** Detect a Composer Pro remote-support session on this computer (its 10.123.x.y relay). */
  detectSidecar: () => action<SidecarDetection>("detect_sidecar"),
  zigbee: (query: ZigbeeQuery) => action<unknown>("zigbee", { query }),
  searchDrivers: (q: { text?: string; search_type?: string; rows?: number }) =>
    action<{ total: number; drivers: DriverDoc[] }>("search_drivers", { ...q, text: q.text ?? "" }),
  listBackups: () => action<{ backups: BackupInfo[] }>("list_backups"),
  backupNow: () => action<BackupResult>("backup_project"),
  compare: (from: string, to: string, runtime = false) => action<{ from: string; to: string; diff: Diff }>("compare_projects", { from, to, runtime }),
  directorRead: (method: string, params: Record<string, unknown> = {}) => action<unknown>("director_read", { method, params }),
  /** Resolves only once the change was approved and applied, declined, or expired. */
  propose: (ops: Op[], reason?: string) => action<Outcome>("propose_changes", { ops, reason }),
  loadBackup: (backup: string, reason?: string) => action<Outcome>("load_backup", { backup, reason }),
  /** Driver files installed on the controller (needs its web API). */
  controllerDrivers: () => action<{ drivers: ControllerDriver[] }>("controller_drivers"),
  /** Driver files in openComposer's library on this computer. */
  libraryDrivers: () => action<{ drivers: LibraryDriver[] }>("library_drivers"),
  /** Copy a .c4z/.c4i into the library. */
  importDriver: (path: string) => action<LibraryDriver>("import_driver", { path }),
  /** Install-if-needed, add and optionally identify, as one approval. Like `propose`, resolves
   *  once it is decided; fails up front when the file is nowhere openComposer can get it. */
  addDriver: (a: AddDriverArgs) => action<Outcome>("add_driver", { ...a }),

  /** Driver icons as data URLs, for the drivers that carry one (.c4z); the rest get none. */
  driverIcons: (filenames?: string[]) => action<{ icons: Record<string, string> }>("driver_icons", { filenames }),
  /** The driver's own web pages (its `<tabs>`), as URLs openComposer serves. */
  driverTabs: (device: number) => action<{ tabs: DriverTab[] }>("driver_tabs", { device }),
  /** What Composer's own editor for a built-in agent shows (Scheduler, Advanced Lighting…). */
  agentView: (id: number) => action<AgentView>("agent_view", { id }),
  /** A device's variables right now (power, level, input…). */
  deviceState: (device: number) => action<DeviceState>("device_state", { device }),
  /** Send a command now — the user's own click, so no approval card; refused on read-only Directors. */
  sendCommand: (device: number, command: string, params: CommandParam[] = []) =>
    action<{ status: "sent"; reply: string[] }>("send_command", { device, command, params }),

  /** Tell the backend what the window shows (for the agent's `ui_context`). */
  setUiContext: (context: UiContext) => call<void>("set_ui_context", { context }),

  // Controller takeover (SSH + cert swap). Not part of the agent/MCP surface — a user action.
  /** Whether openComposer has a takeover CA yet, and where it came from. */
  takeoverStatus: () => call<TakeoverStatus>("takeover_status"),
  /** Adopt an existing "Gary tool" Certs folder's CA (its public.pem + private.key). */
  adoptGaryCa: (folder: string) => call<string>("adopt_gary_ca", { folder }),
  /** Take over a controller. `confirm` is sent true: the UI must confirm before calling. */
  takeOver: (params: TakeoverParams) => call<TakeoverReport>("take_over_controller", { params, confirm: true }),
  /** Undo a takeover on a controller. `confirm` is sent true: the UI must confirm first. */
  revert: (params: RevertParams) => call<TakeoverReport>("revert_takeover", { params, confirm: true }),
};
