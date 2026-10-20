/** A stand-in backend for a plain browser (`npm run dev` outside Tauri).
 *
 *  It answers every command the real one does, from the fixture house in `fixtures.ts`, and
 *  emits the same events: proposals become approval cards and wait for a decision, approving
 *  one edits the fixture project and fires `project-changed`, the agent streams its replies.
 *  `?fresh` in the URL starts with no certificate and no Directors, to see onboarding. */

import type {
  AccessMode, Activity, Announcement, Approval, BackupInfo, Change, CodeLineView, Config, ConnectionDef, ControllerDriver, ConversationInfo,
  DirectorInfo, Entry, Events, ItemDetail, ItemKind, ItemRef, LibraryDriver, McpStatus, Op, Outcome, Peer, Provider, TreeNode,
  UiContext,
} from "../api/types";
import { splitContext } from "./agent.ts";
import {
  BACKUPS, DIRECTORS, DRIVERS, SDDP, ZIGBEE, agentApproval, historyApprovals, seedConversations, seedLibrary, seedProject, showcaseApproval,
  type MItem, type MProject,
} from "./fixtures";

// ---- events --------------------------------------------------------------------------------

type Handler = (payload: never) => void;
const listeners = new Map<string, Set<Handler>>();

function emit<K extends keyof Events>(event: K, payload: Events[K]) {
  // Cloned, so a component holding a payload never sees it change underneath it.
  for (const h of listeners.get(event) ?? []) (h as (p: Events[K]) => void)(structuredClone(payload));
}

export async function listen<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Promise<() => void> {
  const set = listeners.get(event) ?? new Set();
  set.add(handler as Handler);
  listeners.set(event, set);
  return () => set.delete(handler as Handler);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const fresh = typeof location !== "undefined" && new URLSearchParams(location.search).has("fresh");

// ---- state ---------------------------------------------------------------------------------

const project: MProject = seedProject();
const config: Config = {
  directors: fresh ? [] : structuredClone(DIRECTORS),
  active_director: fresh ? null : "d-telaak",
  mcp: { port: 7710, lan: true, token: "3f9a1c0e5d7b42a8c6e1f0b9d2a4c7e8f1a3b5c7d9e0f2a4" },
  agent: { provider: "claude", claude_path: null, codex_path: null, model: null },
};
let identity = fresh
  ? { loaded: false, label: null as string | null, fingerprint: null as string | null, error: null as string | null }
  : { loaded: true, label: "composer.pem (Telaak Integration)", fingerprint: "a4:9e:20:7c:1b:f3:58:d2:6a:0e", error: null };
const connected = new Set<string>(fresh ? [] : ["d-telaak"]);
const approvals: Approval[] = fresh ? [] : [showcaseApproval(), agentApproval(), ...historyApprovals()];
const waiting = new Map<string, (o: Outcome) => void>();
const conversations: ConversationInfo[] = fresh ? [] : seedConversations();
const activity: Activity[] = [];
const restorePoints: BackupInfo[] = [];
let seq = 0;
let nextId = 1000;
/** Driver files on the mock controller: everything the project uses, plus what gets installed. */
const installed = new Set([...project.items.values()].flatMap((i) => (i.driver ? [i.driver] : [])));
let library: LibraryDriver[] = fresh ? [] : seedLibrary();
/** What the window last said it shows (`set_ui_context`); the mock agent reads it. */
let uiContext: UiContext | null = null;

function mcpStatus(): McpStatus {
  return { listening: true, url: `http://${config.mcp.lan ? "192.168.1.25" : "127.0.0.1"}:${config.mcp.port}/mcp`, lan: config.mcp.lan, error: null };
}

function info(id: string): DirectorInfo {
  const d = config.directors.find((x) => x.id === id)!;
  return {
    host: d.host, name: d.name, uuid: `c4-${id}`, device_id: 44, version: "3.4.3.741215", verified_version: true,
    server_fingerprint: d.fingerprint ?? "5f:1c:9a:e2:44:0b:8d:37",
  };
}

function log(source: string, tool: string, summary: string, ok = true, ms = 40 + Math.round(Math.random() * 300)) {
  const a: Activity = { seq: seq++, at: now(), source, tool, summary, ok, ms };
  activity.push(a);
  emit("activity", a);
}

for (const [i, [tool, summary]] of ([
  ["project_overview", ""], ["get_item", "id=22"], ["list_connections", "class=HDMI"], ["get_item", "id=44"],
  ["search_drivers", "text=lg oled"], ["propose_changes", "2 ops"], ["discover_sddp", "4s"], ["zigbee", "nodes"],
] as const).entries()) {
  if (!fresh) activity.push({ seq: seq++, at: new Date(Date.now() - (60 - i * 6) * 60_000).toISOString(),
    source: i % 3 ? "MCP client" : "In-app agent", tool, summary, ok: tool !== "zigbee", ms: 30 + i * 47 });
}

// A real MCP client reads in bursts; keep the Activity tab alive the same way.
if (!fresh) {
  setInterval(() => {
    const tools = [["project_overview", ""], ["get_item", "id=20"], ["find_items", "query=kitchen"], ["get_programming", "device=32"]];
    const [tool, summary] = tools[Math.floor(Math.random() * tools.length)];
    log("MCP client", tool, summary);
  }, 20_000);
}

// ---- project views (mirror app/src/views.rs) -------------------------------------------------

function item(id: number): MItem {
  const it = project.items.get(id);
  if (!it) throw `no item #${id} in this project`;
  return it;
}

function ancestors(id: number): MItem[] {
  const out: MItem[] = [];
  for (let p = project.items.get(id)?.parent ?? null; p != null; p = project.items.get(p)?.parent ?? null) {
    const it = project.items.get(p);
    if (!it) break;
    if (it.kind !== "project") out.unshift(it);
  }
  return out;
}

const path = (id: number) => [...ancestors(id).map((a) => a.name), item(id).name].join(" › ");
const roomOf = (id: number) => (item(id).kind === "room" ? item(id) : [...ancestors(id)].reverse().find((a) => a.kind === "room"));
const short = (id: number) => {
  const it = project.items.get(id);
  return it ? { id, name: it.name, kind: it.kind, driver: it.driver } : { id, name: `#${id}` };
};

function itemRef(id: number): ItemRef {
  const it = item(id);
  const kind: ItemKind = it.kind === "item" ? { other: 0 } : it.kind;
  return { id, name: it.name, item_kind: kind, location: ancestors(id).map((a) => a.name) };
}

function tree(id: number): TreeNode {
  const it = item(id);
  return { id, name: it.name, kind: it.kind, driver: it.driver, children: it.children.map(tree) };
}

function connectionName(device: number, binding: number) {
  return project.catalog.get(device)?.connections.find((c) => c.id === binding)?.name ?? null;
}

function connectionsOf(id: number): ConnectionDef[] {
  const dev = project.catalog.get(id);
  if (!dev) return [];
  return dev.connections.map((c) => {
    const peers: Peer[] = [];
    for (const b of project.bindings) {
      if (b.consumer_device === id && b.consumer_binding === c.id) {
        peers.push({ device: short(b.provider_device), binding: b.provider_binding, connection: connectionName(b.provider_device, b.provider_binding), classes: b.classes });
      } else if (b.provider_device === id && b.provider_binding === c.id) {
        peers.push({ device: short(b.consumer_device), binding: b.consumer_binding, connection: b.consumer_name, classes: b.classes });
      }
    }
    return { id: c.id, name: c.name, role: c.consumer ? "input" : "output", classes: c.classes, connected_to: peers };
  });
}

const SENSITIVE = ["password", "passcode", "passphrase", "secret", "token", "api key", "apikey", "pin code", "private key"];
const masked = (name: string, value: string) =>
  SENSITIVE.some((s) => name.toLowerCase().includes(s)) && value ? "••••••" : value;

function itemDetail(id: number): ItemDetail {
  const it = item(id);
  const dev = project.catalog.get(id);
  const properties = dev?.properties.length
    ? dev.properties.map((d) => ({
        name: d.name, value: masked(d.name, it.properties[d.name] ?? d.default ?? ""), type: d.prop_type,
        readonly: !!d.readonly, options: d.items ?? [], min: d.minimum ?? null, max: d.maximum ?? null,
      }))
    : Object.entries(it.properties).map(([name, value]) => ({ name, value: masked(name, value) }));
  return {
    id, name: it.name, kind: it.kind, path: path(id), room: roomOf(id)?.name ?? null, driver: it.driver,
    device: dev ? { manufacturer: dev.manufacturer, model: dev.model, driver_name: dev.driver_name, version: dev.version,
      control_method: dev.control_method, search_type: dev.search_type, proxies: dev.proxies } : null,
    properties,
    actions: dev ? dev.actions.map(([name, command]) => ({ name, command })) : null,
    connections: connectionsOf(id),
    network: project.network.filter((n) => n.device === id),
    network_connections: project.network.some((n) => n.device === id) ? [{ id: 6001, name: "IP Connection", classes: ["TCP"] }] : [],
    variables: project.variables.filter((v) => v.device === id),
    events: dev ? Object.entries(dev.events).map(([eid, name]) => ({ id: Number(eid), name, programming: project.programming.get(`${id}:${eid}`) ?? [] })) : [],
    children: it.children.map((c) => ({ ...short(c), kind: item(c).kind, driver: item(c).driver, connections: connectionsOf(c) })),
  };
}

// ---- proposals ---------------------------------------------------------------------------------

/** What an op will do, as the backend would show it. Good enough for a preview. */
function describe(op: Op): string {
  const n = (id: number) => `“${project.items.get(id)?.name ?? `#${id}`}”`;
  switch (op.op) {
    case "add_device": return `Add “${op.name}” (${op.driver}) to ${n(op.room)}`;
    case "add_room": return `Add room “${op.name}” to ${n(op.floor)}`;
    case "remove_item": return `Remove ${project.items.get(op.id)?.kind ?? "item"} ${n(op.id)}`;
    case "rename_item": return `Rename ${n(op.id)} to “${op.name}”`;
    case "move_item": return `Move ${n(op.id)} to ${n(op.parent)}`;
    case "add_connection": return `Connect ${n(op.provider_device)} #${op.provider_binding} → ${n(op.consumer_device)} #${op.consumer_binding} (${op.class})`;
    case "remove_connection": return `Disconnect ${n(op.consumer_device)} #${op.consumer_binding} (${op.class})`;
    case "add_network_binding": return `Identify ${op.device === 0 ? "the new device" : n(op.device)} as ${op.search_type} at ${op.address}`;
    case "remove_network_binding": return `Remove network identity of ${n(op.device)}`;
    case "set_property": return `Set ${n(op.device)} property “${op.name}” to “${masked(op.name, op.value)}”`;
    case "install_driver": return `Install driver file ${op.filename} from ${op.source}`;
    case "run_action": return `Run action “${op.command}” on ${n(op.device)}`;
    case "add_code": return `Add to ${n(op.device)} programming: “${op.display.replace("NAME", project.items.get(op.target)?.name ?? "")}”`;
    case "remove_code": return `Remove programming line #${op.id} from ${n(op.device)}`;
    case "load_project": return `Replace the whole project with ${op.label}`;
  }
}

function subtree(id: number): number[] {
  const it = project.items.get(id);
  return it ? [id, ...it.children.flatMap(subtree)] : [];
}

function predict(ops: Op[]): Change[] {
  const changes: Change[] = [];
  // Director assigns real ids; a preview only needs distinct ones.
  let guess = nextId;
  // `add_driver` identifies the device it adds as device 0: the one added just before.
  let added: ItemRef | null = null;
  for (const op of ops) {
    switch (op.op) {
      case "add_device":
      case "add_room": {
        const parent = op.op === "add_device" ? op.room : op.floor;
        const kind: ItemKind = op.op === "add_device" ? "device" : "room";
        added = { id: guess++, name: op.name, item_kind: kind, location: [...ancestors(parent).map((a) => a.name), item(parent).name] };
        changes.push({ kind: "item_added", driver: op.op === "add_device" ? op.driver : "roomdevice.c4i", descendants: 0, item: added });
        break;
      }
      case "remove_item": {
        const ids = new Set(subtree(op.id));
        changes.push({ kind: "item_removed", item: itemRef(op.id), driver: item(op.id).driver, descendants: ids.size - 1 });
        for (const b of project.bindings.filter((b) => ids.has(b.consumer_device) || ids.has(b.provider_device))) {
          changes.push({ kind: "connection_removed", cascade: true, connection: bindingConnection(b) });
        }
        for (const nb of project.network.filter((x) => ids.has(x.device))) {
          changes.push({ kind: "network_removed", item: itemRef(nb.device), binding: nb.binding, address_type: nb.address_type,
            address: nb.address, uuid: nb.uuid, search_type: nb.search_type, cascade: true });
        }
        for (const v of project.variables.filter((x) => ids.has(x.device))) {
          changes.push({ kind: "variable_removed", owner: itemRef(v.device), id: v.id, name: v.name, value: v.value, cascade: true });
        }
        break;
      }
      case "rename_item":
        changes.push({ kind: "item_renamed", item: { ...itemRef(op.id), name: op.name }, from: item(op.id).name, to: op.name });
        break;
      case "move_item":
        changes.push({ kind: "item_moved", item: itemRef(op.id), from: ancestors(op.id).map((a) => a.name),
          to: [...ancestors(op.parent).map((a) => a.name), item(op.parent).name] });
        break;
      case "add_connection":
        changes.push({ kind: "connection_added", connection: bindingConnection({ ...op, classes: [op.class] }) });
        break;
      case "remove_connection": {
        const b = project.bindings.find((x) => x.consumer_device === op.consumer_device && x.consumer_binding === op.consumer_binding && x.classes.includes(op.class));
        if (!b) throw `${item(op.consumer_device).name} connection #${op.consumer_binding} has no ${op.class} connection to remove`;
        changes.push({ kind: "connection_removed", cascade: false, connection: bindingConnection(b) });
        break;
      }
      case "add_network_binding":
        changes.push({ kind: "network_added", item: op.device === 0 && added ? added : itemRef(op.device), binding: op.binding, address_type: op.address_type,
          address: op.address, uuid: op.address, search_type: op.search_type });
        break;
      case "remove_network_binding": {
        const nb = project.network.find((x) => x.device === op.device && x.binding === op.binding);
        if (!nb) throw `${item(op.device).name} has no network binding #${op.binding}`;
        changes.push({ kind: "network_removed", item: itemRef(op.device), binding: nb.binding, address_type: nb.address_type,
          address: nb.address, uuid: nb.uuid, search_type: nb.search_type, cascade: false });
        break;
      }
      case "set_property": {
        const def = project.catalog.get(op.device)?.properties.find((p) => p.name === op.name);
        if (!def) throw `“${item(op.device).name}” has no property “${op.name}” (get_item lists its properties)`;
        if (def.readonly) throw `“${item(op.device).name}” property “${op.name}” is read-only; the driver sets it`;
        if (def.items?.length && !def.items.includes(op.value)) throw `“${op.name}” must be one of: ${def.items.join(", ")}`;
        const before = item(op.device).properties[op.name] ?? def.default ?? null;
        changes.push({ kind: "property_changed", item: itemRef(op.device), property: op.name,
          from: before == null ? null : masked(op.name, before), to: masked(op.name, op.value) });
        break;
      }
      case "install_driver":
      case "run_action":
      case "add_code":
      case "remove_code":
        break;
      case "load_project":
        changes.push({ kind: "property_changed", item: itemRef(20), property: "Power On Delay (ms)", from: "2500", to: "3000" });
        break;
    }
  }
  return changes;
}

function bindingConnection(b: { consumer_device: number; consumer_binding: number; provider_device: number; provider_binding: number; consumer_name: string; classes: string[] }) {
  return {
    classes: b.classes,
    consumer: { device: itemRef(b.consumer_device), binding: b.consumer_binding, connection: b.consumer_name || connectionName(b.consumer_device, b.consumer_binding) },
    provider: { device: itemRef(b.provider_device), binding: b.provider_binding, connection: connectionName(b.provider_device, b.provider_binding) },
  };
}

/** Do it, for real (to the fixture). Returns ids Director would have assigned. */
function apply(op: Op): number[] {
  switch (op.op) {
    case "add_device":
    case "add_room": {
      const id = nextId++;
      const parent = op.op === "add_device" ? op.room : op.floor;
      project.items.set(id, { id, name: op.name, kind: op.op === "add_device" ? "device" : "room", parent, children: [],
        driver: op.op === "add_device" ? op.driver : "roomdevice.c4i", properties: {} });
      item(parent).children.push(id);
      if (op.op === "add_device") {
        const doc = DRIVERS.find((d) => d.filename === op.driver);
        project.catalog.set(id, {
          manufacturer: doc?.manufacturer ?? "", model: doc?.model ?? "", driver_name: doc?.name ?? op.driver, version: String(doc?.version ?? 1),
          control_method: doc?.control_method ?? "", search_type: doc?.search_types[0] ?? "", proxies: doc?.proxies ?? [],
          connections: (doc?.connection_names ?? []).map((name, i) => ({ id: 2000 + i, name, consumer: !/out/i.test(name), classes: [doc?.connection_classes[0] ?? "HDMI"] })),
          events: {}, properties: [], actions: [],
        });
      }
      return [id];
    }
    case "remove_item": {
      const ids = new Set(subtree(op.id));
      const parent = item(op.id).parent;
      if (parent != null) item(parent).children = item(parent).children.filter((c) => c !== op.id);
      for (const id of ids) project.items.delete(id);
      project.bindings = project.bindings.filter((b) => !ids.has(b.consumer_device) && !ids.has(b.provider_device));
      project.network = project.network.filter((n) => !ids.has(n.device));
      project.variables = project.variables.filter((v) => !ids.has(v.device));
      return [];
    }
    case "rename_item":
      item(op.id).name = op.name;
      return [];
    case "move_item": {
      const it = item(op.id);
      if (it.parent != null) item(it.parent).children = item(it.parent).children.filter((c) => c !== op.id);
      item(op.parent).children.push(op.id);
      it.parent = op.parent;
      return [];
    }
    case "add_connection":
      project.bindings.push({ consumer_device: op.consumer_device, consumer_binding: op.consumer_binding, provider_device: op.provider_device,
        provider_binding: op.provider_binding, consumer_name: op.consumer_name, classes: [op.class] });
      return [];
    case "remove_connection":
      project.bindings = project.bindings.filter((b) => !(b.consumer_device === op.consumer_device && b.consumer_binding === op.consumer_binding && b.classes.includes(op.class)));
      return [];
    case "add_network_binding":
      project.network = project.network.filter((n) => !(n.device === op.device && n.binding === op.binding));
      project.network.push({ device: op.device, binding: op.binding, address_type: op.address_type, address: op.address, uuid: op.address,
        search_type: op.search_type, status: "online" });
      return [];
    case "remove_network_binding":
      project.network = project.network.filter((n) => !(n.device === op.device && n.binding === op.binding));
      return [];
    case "set_property":
      item(op.device).properties[op.name] = op.value;
      return [];
    case "install_driver":
      installed.add(op.filename);
      return [];
    case "run_action":
    case "add_code":
    case "remove_code":
      return [];
    case "load_project":
      return [];
  }
}

function outcome(a: Approval): Outcome {
  const msg: Record<Approval["status"], string> = {
    applied: "Approved and applied.",
    denied: a.note ? `The user declined this change: ${a.note}` : "The user declined this change. Ask what they want instead.",
    expired: "No one approved this within 15 minutes; nothing was changed.",
    failed: `Approved, but Director refused: ${a.error ?? ""}`,
    pending: "Still in progress.", applying: "Still in progress.",
  };
  return {
    status: a.status, message: msg[a.status], approval_id: a.id, changes: a.descriptions,
    created_item_ids: a.applied.flatMap((x) => x.created), restore_point: a.restore_point,
    verification: a.verification && { predicted_changes_seen: a.verification.matched, predicted_but_missing: a.verification.missing,
      other_changes_director_made: a.verification.side_effects.changes.length },
  };
}

function propose(ops: Op[], reason: string | null, source: string, label?: string): Promise<Outcome> {
  if (!ops.length) throw "no changes were given";
  const d = config.directors.find((x) => x.id === config.active_director);
  if (!d) throw "no Director is set up — add one in Directors";
  if (d.mode === "read_only") throw `${d.name} is read-only in openComposer; switch it to “approve each write” in Directors to allow changes`;
  const changes = predict(ops);
  const summary = { added: 0, removed: 0, changed: 0 };
  for (const c of changes) summary[c.kind.endsWith("_added") ? "added" : c.kind.endsWith("_removed") ? "removed" : "changed"]++;
  const a: Approval = {
    id: `ap-${Date.now().toString(36)}`, created: now(), decided: null, director_id: d.id, director_name: d.name, project: project.name,
    source, reason, ops, descriptions: label ? [label] : ops.map(describe), diff: { changes, summary }, status: "pending",
    note: null, error: null, applied: [], restore_point: null, verification: null,
  };
  approvals.unshift(a);
  emit("approval", a);
  emit("attention", { kind: "approval", id: a.id, title: a.descriptions[0] ?? null });
  return new Promise((resolve) => waiting.set(a.id, resolve));
}

async function decide(id: string, approve: boolean, note: string | null): Promise<boolean> {
  const a = approvals.find((x) => x.id === id);
  if (!a || a.status !== "pending") return false;
  const resolve = waiting.get(id);
  waiting.delete(id);
  a.decided = now();
  a.note = note;
  const finish = () => {
    emit("approval", a);
    resolve?.(outcome(a));
    agentFollowUp(a);
  };
  if (!approve) {
    a.status = "denied";
    finish();
    return true;
  }
  a.status = "applying";
  emit("approval", a);
  void (async () => {
    await sleep(1400);
    const stamp = new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, "");
    const file = `${project.name} ${stamp} before change.c4p`;
    a.restore_point = `${BACKUPS[0].path.replace(/[^/]*$/, "")}${file}`;
    restorePoints.unshift({ ...BACKUPS[0], file, path: a.restore_point, created: new Date().toLocaleString() });
    try {
      // Device 0 in an identify is the device this same approval just added.
      let made: number | undefined;
      a.applied = a.ops.map((op) => {
        const created = apply(op.op === "add_network_binding" && op.device === 0 && made != null ? { ...op, device: made } : op);
        made = created[0] ?? made;
        return { created, notes: [] };
      });
      a.status = "applied";
      const added = a.diff.changes.find((c) => c.kind === "item_added");
      a.verification = {
        matched: a.diff.changes.length,
        missing: [],
        // Director adds its own variables to a new device; show that as an unpredicted follow-up.
        side_effects: added && added.kind === "item_added" && added.item.item_kind === "device"
          ? { summary: { added: 1, removed: 0, changed: 0 }, changes: [{ kind: "variable_added", owner: added.item, id: 1000, name: "POWER_STATE", value: "Off" }] }
          : { summary: { added: 0, removed: 0, changed: 0 }, changes: [] },
      };
    } catch (e) {
      a.status = "failed";
      a.error = String(e);
    }
    finish();
    emit("project-changed", { director: a.director_id });
    emit("backups", backups());
  })();
  return true;
}

const backups = (): BackupInfo[] => [...restorePoints, ...BACKUPS];

// ---- the agent ---------------------------------------------------------------------------------

function conv(id: string): ConversationInfo {
  const c = conversations.find((x) => x.id === id);
  if (!c) throw "no such conversation";
  return c;
}

const push = (c: ConversationInfo, e: Entry) => {
  c.entries.push(e);
  emit("agent", c);
};

async function stream(c: ConversationInfo, text: string) {
  const e: Entry = { role: "assistant", text: "", streaming: true };
  c.entries.push(e);
  for (let i = 0; i < text.length && c.busy; i += 4) {
    e.text = text.slice(0, i + 4);
    emit("agent", c);
    await sleep(28);
  }
  e.streaming = false;
  emit("agent", c);
}

/** When a decision lands on a proposal the agent is waiting for, finish its turn. */
function agentFollowUp(a: Approval) {
  if (a.source !== "In-app agent") return;
  for (const c of conversations) {
    const t = [...c.entries].reverse().find((e) => e.role === "tool" && /(propose_changes|add_driver)$/.test(e.name) && e.output == null);
    if (!t || t.role !== "tool") continue;
    t.output = outcome(a);
    emit("agent", c);
    void (async () => {
      await sleep(400);
      await stream(c, a.status === "applied"
        ? `Done — the change is applied and Director confirmed ${a.verification?.matched ?? 0} predicted change(s). A restore point was saved first, in case you want to roll back.`
        : `Understood, I won't make that change.${a.note ? ` You said: “${a.note}”. ` : " "}What would you like instead?`);
      c.busy = false;
      c.cost_usd += 0.0061;
      emit("agent", c);
    })();
    return;
  }
}

/** Run a tool call the way the transcript shows one: the call, a pause, its answer. */
async function tool(c: ConversationInfo, name: string, input: unknown, run: () => unknown) {
  const t: Entry = { role: "tool", id: `t-${Date.now()}-${name}`, name, input, output: null, is_error: false };
  push(c, t);
  await sleep(450);
  try {
    t.output = run();
  } catch (e) {
    t.output = String(e);
    t.is_error = true;
  }
  emit("agent", c);
  return t.output;
}

const TABS = ["properties", "connections", "network", "variables", "events"] as const;

/** The tab a request is about, from its words. */
function tabFor(text: string): (typeof TABS)[number] | undefined {
  if (/connect|wired|wiring|hdmi|\bir\b|input/i.test(text)) return "connections";
  if (/network|\bip\b|identif|address/i.test(text)) return "network";
  if (/program|event|when /i.test(text)) return "events";
  if (/variable/i.test(text)) return "variables";
  if (/propert|setting/i.test(text)) return "properties";
  return undefined;
}

/** The project item a request names, longest name first ("Living Receiver" over "Living"). */
function mentioned(text: string): MItem | undefined {
  const t = text.toLowerCase();
  return [...project.items.values()]
    .filter((i) => i.kind !== "proxy" && i.kind !== "project" && t.includes(i.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/** How an item is wired, one line per connection that goes somewhere. */
function wiring(id: number): string[] {
  const it = item(id);
  return [id, ...it.children].flatMap((x) => connectionsOf(x).flatMap((c) =>
    c.connected_to.map((p) => `- **${c.name}** ${c.role === "input" ? "←" : "→"} ${p.device.name} › ${p.connection ?? `#${p.binding}`}`)));
}

/** A turn from the Design ask bar: it knows what you're looking at, can point the window at
 *  something else (ui_show), and proposes changes to "this". */
async function designTurn(c: ConversationInfo, text: string) {
  const ctx = (await tool(c, "ui_context", {}, () => uiContext ?? { note: "the window hasn't reported what it shows" })) as UiContext | null;
  if (!c.busy) return;
  const here = ctx?.item ? project.items.get(ctx.item.id) : undefined;
  const target = mentioned(text);
  const tab = tabFor(text);
  const rename = /\brename (?:this|it)?\s*(?:to|as)\s+[“"']?(.+?)[”"']?\s*$/i.exec(text);

  if (rename && here && here.kind !== "project") {
    const to = rename[1].trim();
    await stream(c, `Renaming **${here.name}** to **${to}** — approve it below.`);
    const ops: Op[] = [{ op: "rename_item", id: here.id, name: to }];
    push(c, { role: "tool", id: `t-${Date.now()}`, name: "propose_changes", input: { ops, reason: "Rename as asked." }, output: null, is_error: false });
    void propose(ops, "Rename as asked.", "In-app agent").catch((e) => push(c, { role: "error", text: String(e) }));
    return;
  }
  if (target && target.id !== here?.id) {
    const show = { item: target.id, tab, approvals: false };
    await tool(c, "ui_show", show, () => {
      emit("ui-command", show);
      return { ok: true, shown: show };
    });
    const lines = wiring(target.id);
    await stream(c, [
      `I've selected **${target.name}** in ${roomOf(target.id)?.name ?? "the project"}${tab ? ` and opened its *${tab}* tab` : ""}.`,
      "",
      ...(lines.length ? ["It's wired like this:", ...lines] : ["It has no connections yet."]),
    ].join("\n"));
  } else if (here) {
    const d = (await tool(c, "get_item", { id: here.id }, () => itemDetail(here.id))) as ItemDetail;
    const lines = wiring(here.id);
    await stream(c, [
      `**${d.name}** is a ${d.kind}${d.device ? ` — ${d.device.manufacturer} ${d.device.model}, driver \`${d.driver}\`` : ""}${d.room && d.kind !== "room" ? `, in ${d.room}` : ""}.`,
      "",
      ...(d.kind === "room" ? [`It holds ${plural(d.children.length, "item")}: ${d.children.map((x) => x.name).join(", ") || "nothing yet"}.`]
        : lines.length ? ["Connections:", ...lines] : ["Nothing is connected to it yet."]),
      ...(d.network.length ? ["", `On the network at \`${d.network[0].address}\` (${d.network[0].status}).`] : []),
      "",
      "Try *“show me the Theater Receiver's connections”* or *“rename this to …”*.",
    ].join("\n"));
  } else {
    await stream(c, "Nothing is selected, so I looked at the whole project: **Telaak House** has 4 rooms and 10 devices. Name something — *“show me the Bedroom TV”* — and I'll bring it up.");
  }
  c.busy = false;
  c.cost_usd += 0.0039;
  emit("agent", c);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

async function agentTurn(c: ConversationInfo, raw: string) {
  if (!c.entries.length) push(c, { role: "status", text: `Connected to ${c.provider === "claude" ? "Claude" : "Codex"} (17 openComposer tools).` });
  await sleep(500);
  const { context, text } = splitContext(raw);
  if (context) return designTurn(c, text);
  const wantsChange = /\b(rename|call it|name it)\b/i.test(text);
  const t: Entry = { role: "tool", id: `t-${Date.now()}`, name: "find_items", input: { query: "Kitchen" }, output: null, is_error: false };
  push(c, t);
  await sleep(600);
  t.output = { matches: [{ id: 30, name: item(30).name, kind: "device", driver: item(30).driver, path: path(30) }] };
  emit("agent", c);
  if (!c.busy) return;
  if (wantsChange) {
    await stream(c, "I found **Kitchen Lights** (#30). Proposing the rename now — you'll see the card below.");
    const ops: Op[] = [{ op: "rename_item", id: 30, name: "Kitchen Pendants" }];
    push(c, { role: "tool", id: `t-${Date.now()}`, name: "propose_changes", input: { ops, reason: "Rename as asked." }, output: null, is_error: false });
    void propose(ops, "Rename as asked.", "In-app agent").catch((e) => push(c, { role: "error", text: String(e) }));
    return;
  }
  await stream(c, [
    `Here's what I found for “${text.slice(0, 40)}”:`, "",
    `- **${item(30).name}** in *Kitchen* — \`${item(30).driver}\`, level **65%**`,
    "- Programmed from the **Kitchen Keypad** (button 1 toggles it) and the **Scheduler** at sunset.", "",
    "Ask me to *rename* it to see an approval card here in the chat.",
  ].join("\n"));
  c.busy = false;
  c.cost_usd += 0.0043;
  emit("agent", c);
}

// ---- the command router ------------------------------------------------------------------------

type Args = Record<string, unknown>;

function ensureSession(): string {
  if (!identity.loaded) throw "no client certificate yet — import composer.pem/.key (or a .p12) in Settings";
  const id = config.active_director;
  if (!id) throw "no Director is set up — add one in Directors";
  if (!connected.has(id)) {
    connected.add(id);
    emit("director", { id, connected: true, info: info(id) });
  }
  return id;
}

async function act(name: string, a: Args): Promise<unknown> {
  switch (name) {
    case "discover_sddp": {
      await sleep(Math.min(Number(a.seconds ?? 4), 4) * 400);
      return { devices: SDDP.map((s): Announcement => ({ kind: "200 OK", primary_proxy: "", proxies: [], config_url: "", max_age: 1800,
        headers: { Host: s.host, Type: s.device_type }, ...s })) };
    }
    case "search_drivers": {
      await sleep(350);
      const text = String(a.text ?? "").toLowerCase();
      const st = a.search_type as string | undefined;
      const hits = DRIVERS.filter((d) => st
        ? d.search_types.some((t) => st.startsWith(t) || t.startsWith(st))
        : !text || text.split(/\s+/).every((w) => `${d.name} ${d.manufacturer} ${d.model} ${d.filename}`.toLowerCase().includes(w)));
      return { total: hits.length, drivers: hits.slice(0, Number(a.rows ?? 20)) };
    }
    case "list_backups":
      return { backups: backups() };
    case "library_drivers":
      return { drivers: library };
    case "import_driver": {
      await sleep(300);
      const path = String(a.path);
      const file = path.split(/[\\/]/).pop() ?? path;
      if (!/\.(c4z|c4i)$/i.test(file)) throw `${file} isn't a driver file (.c4z or .c4i)`;
      const doc = DRIVERS.find((d) => d.filename.toLowerCase() === file.toLowerCase());
      const d: LibraryDriver = {
        filename: file, name: doc?.name ?? file.replace(/\.c4[zi]$/i, "").replace(/[_-]+/g, " "), manufacturer: doc?.manufacturer ?? "",
        model: doc?.model ?? "", version: doc?.version ?? 1, creator: doc?.creator ?? "", control_method: doc?.control_method ?? "",
        search_types: doc?.search_types ?? [], proxies: doc?.proxies ?? [], network_bindings: [6001], size: 96_512,
        path: `~/Library/Application Support/com.openComposer.openComposer/drivers/${file}`, source: "library",
      };
      library = [...library.filter((x) => x.filename !== file), d];
      log("You (openComposer)", "import_driver", path);
      return d;
    }
  }
  ensureSession();
  switch (name) {
    case "director_info":
      return { id: config.active_director, mode: "approve", info: info(config.active_director!) };
    case "project_overview": {
      const all = [...project.items.values()];
      const count = (k: string) => all.filter((i) => i.kind === k).length;
      return {
        project: project.name,
        counts: { rooms: count("room"), devices: count("device"), agents: count("agent"), connections: project.bindings.length,
          network_bindings: project.network.length, events_with_programming: project.programming.size },
        rooms: all.filter((i) => i.kind === "room").map((r) => ({ id: r.id, name: r.name, location: ancestors(r.id).map((x) => x.name).join(" › "),
          devices: r.children.map(item).filter((d) => d.kind === "device").map((d) => ({ id: d.id, name: d.name, driver: d.driver })) })),
        agents: all.filter((i) => i.kind === "agent").map((x) => ({ id: x.id, name: x.name, driver: x.driver })),
      };
    }
    case "project_tree":
      await sleep(150);
      return { tree: tree(1), project: project.name };
    case "find_items": {
      const q = String(a.query ?? "").toLowerCase();
      return { matches: [...project.items.values()]
        .filter((i) => (!a.kind || i.kind === a.kind) && (i.name.toLowerCase().includes(q) || !!i.driver?.toLowerCase().includes(q)))
        .map((i) => ({ id: i.id, name: i.name, kind: i.kind, driver: i.driver, path: path(i.id) })) };
    }
    case "get_item":
      await sleep(120);
      return itemDetail(Number(a.id));
    case "list_connections": {
      const cls = (a.class as string | undefined)?.toUpperCase();
      const rows = [];
      for (const id of project.catalog.keys()) {
        const it = project.items.get(id);
        if (!it) continue;
        if (a.device != null && a.device !== id && it.parent !== a.device) continue;
        for (const c of connectionsOf(id)) {
          if (a.unconnected_only && c.connected_to.length) continue;
          if (cls && !c.classes.includes(cls)) continue;
          rows.push({ device: { id, name: it.name, room: roomOf(id)?.name ?? null }, connection: c });
        }
      }
      return { connections: rows };
    }
    case "get_programming":
      return { events: [...project.programming.entries()]
        .map(([k, lines]) => [k.split(":").map(Number), lines] as [number[], CodeLineView[]])
        .filter(([[d]]) => (a.device == null || a.device === d) && project.items.has(d))
        .map(([[d, e], lines]) => ({ device: short(d), event: e, event_name: project.catalog.get(d)?.events[e] ?? null, lines })) };
    case "network_status": {
      const found = SDDP.filter((s) => s.device_type.startsWith("c4:") && !s.device_type.startsWith("c4:control4"))
        .map((s) => ({ uuid: s.host, address: s.address, address_type: 1, device_type: s.device_type }));
      const bound = new Set(project.network.map((n) => n.uuid));
      return {
        identified: project.network.map((n) => ({ device: { id: n.device, name: item(n.device).name, path: path(n.device) },
          address_type: n.address_type, address: n.address, uuid: n.uuid, search_type: n.search_type, status: n.status })),
        discovered: found,
        discovered_not_in_project: found.filter((f) => !bound.has(f.uuid)),
      };
    }
    case "zigbee":
      await sleep(500);
      return ZIGBEE[String(a.query)] ?? "";
    case "backup_project": {
      await sleep(900);
      const used = [...new Set([...project.items.values()].flatMap((i) => (i.driver?.endsWith(".c4z") ? [i.driver] : [])))];
      // One community driver the controller won't hand over, as happens with encrypted ones.
      const missing = used.filter((f) => f.startsWith("ecobee"));
      const b = { ...BACKUPS[1], file: `${project.name} ${new Date().toISOString().slice(0, 10)} backup.c4p`, created: new Date().toLocaleString(),
        drivers: used.length - missing.length };
      BACKUPS.unshift(b);
      emit("backups", backups());
      log("You (openComposer)", "backup_project", "");
      return { ...b, drivers_missing: missing, note: null };
    }
    case "compare_projects": {
      await sleep(700);
      const base = showcaseApproval().diff;
      const changes = base.changes.filter((c) => a.runtime || !(c.kind === "network_changed" && c.field === "status"));
      return { from: describeSource(String(a.from)), to: describeSource(String(a.to)), diff: { ...base, changes } };
    }
    case "director_read":
      return { [`${a.method}Response`]: { note: "mock Director: reads return this placeholder" } };
    case "propose_changes": {
      log("You (openComposer)", "propose_changes", `${(a.ops as Op[]).length} ops`);
      return propose(a.ops as Op[], (a.reason as string) ?? null, "You (openComposer)");
    }
    case "driver_status": {
      const d = config.directors.find((x) => x.id === config.active_director)!;
      if (!d.web_api) throw `the web API is switched off for ${d.name} (Directors → web API); driver files need it`;
      await sleep(250);
      const f = String(a.filename);
      return { filename: f, installed: installed.has(f), info: installed.has(f) ? { name: f, version: DRIVERS.find((x) => x.filename === f)?.version ?? 1, size: 48_213 } : null };
    }
    case "install_driver": {
      const from = String(a.from);
      const source = from.startsWith("path:") ? `file ${from.slice(5)}` : from.startsWith("director:") ? `Director ${from.slice(9)}` : `backup ${from.slice(7)}`;
      log("You (openComposer)", "install_driver", `${a.filename} from ${from}`);
      return propose([{ op: "install_driver", filename: String(a.filename), source }], (a.reason as string) ?? null, "You (openComposer)");
    }
    case "controller_drivers": {
      const d = config.directors.find((x) => x.id === config.active_director)!;
      if (!d.web_api) throw `the web API is switched off for ${d.name} (Directors → web API); the controller's driver list needs it`;
      await sleep(300);
      return { drivers: controllerDrivers() };
    }
    case "add_driver":
      log("You (openComposer)", "add_driver", `${a.filename} → #${a.room}`);
      return propose(addDriverOps(a), (a.reason as string) ?? null, "You (openComposer)");
    case "load_backup":
      log("You (openComposer)", "load_backup", String(a.backup));
      return propose([{ op: "load_project", label: String(a.backup) }], (a.reason as string) ?? null, "You (openComposer)");
  }
  throw `unknown action ${name}`;
}

/** What the controller's web API would list: every installed file that isn't a proxy or the
 *  room driver, described from the database fixture or the device using it. */
function controllerDrivers(): ControllerDriver[] {
  const users = new Map<string, MItem>();
  for (const it of project.items.values()) if (it.driver && !users.has(it.driver)) users.set(it.driver, it);
  return [...installed].flatMap((f): ControllerDriver[] => {
    const user = users.get(f);
    if (user && (user.kind === "proxy" || user.kind === "room")) return [];
    const doc = DRIVERS.find((d) => d.filename === f);
    const cat = user ? project.catalog.get(user.id) : undefined;
    return [{
      filename: f, name: doc?.name ?? cat?.driver_name ?? f, manufacturer: doc?.manufacturer ?? cat?.manufacturer ?? "",
      model: doc?.model ?? cat?.model ?? "", version: doc?.version ?? cat?.version ?? null,
      searchTypes: doc?.search_types ?? (cat?.search_type ? [cat.search_type] : []), proxies: doc?.proxies ?? cat?.proxies ?? [],
      primaryProxy: doc?.primary_proxy ?? cat?.proxies[0] ?? "", isAgent: user?.kind === "agent", isCombo: false, md5sum: "",
      created: "2026-03-02T10:14:00Z", modified: "2026-09-30T14:03:44Z", certified: doc?.certified ?? true,
      category: user?.kind === "agent" ? "agent" : "device",
    }];
  });
}

/** `add_driver` as the backend builds it: install the file first when the controller lacks
 *  it (from the library, else downloaded from the database fixture and kept in the library),
 *  add the device, then identify it as "device 0" — the one just added. */
function addDriverOps(a: Args): Op[] {
  const file = String(a.filename);
  const ops: Op[] = [];
  let lib = library.find((x) => x.filename.toLowerCase() === file.toLowerCase());
  if (!installed.has(file)) {
    let source = lib?.source === "composer" ? "Composer's driver folder" : "the driver library";
    if (!lib) {
      const doc = DRIVERS.find((d) => d.filename.toLowerCase() === file.toLowerCase());
      if (!doc) {
        throw `${file} isn't in Control4's driver database. It isn't on this controller, in the driver library or on another `
          + "connected Director either; import the file into the library first.";
      }
      lib = {
        filename: doc.filename, name: doc.name, manufacturer: doc.manufacturer, model: doc.model, version: doc.version, creator: doc.creator,
        control_method: doc.control_method, search_types: doc.search_types, proxies: doc.proxies, network_bindings: [6001], size: 152_064,
        path: `~/Library/Application Support/com.openComposer.openComposer/drivers/${doc.filename}`, source: "library",
      };
      library = [...library, lib];
      source = "Control4's driver database (checksum verified)";
    }
    ops.push({ op: "install_driver", filename: file, source });
  }
  const name = String(a.name ?? "").trim() || lib?.name || DRIVERS.find((d) => d.filename === file)?.name || file;
  ops.push({ op: "add_device", room: Number(a.room), name, driver: file });
  const id = a.identify as { address: string; search_type: string; address_type?: number; binding?: number } | undefined;
  if (id) {
    ops.push({ op: "add_network_binding", device: 0, binding: id.binding ?? lib?.network_bindings[0] ?? 6001,
      address_type: id.address_type ?? 1, address: id.address, search_type: id.search_type });
  }
  return ops;
}

function describeSource(s: string) {
  if (s.startsWith("backup:")) return `backup ${s.slice(7)}`;
  return `live ${config.directors.find((d) => d.id === (s.split(":")[1] || config.active_director))?.name ?? "Director"}`;
}

async function handle(cmd: string, a: Args): Promise<unknown> {
  switch (cmd) {
    case "app_status":
      return { version: "0.1.0", config, identity, mcp: mcpStatus(), connected: [...connected],
        stdio_command: "/Applications/openComposer.app/Contents/MacOS/openComposer" };
    case "import_identity_pem":
    case "import_identity_p12": {
      await sleep(300);
      const file = String(a.cert ?? a.path).split(/[\\/]/).pop();
      identity = { loaded: true, label: `${file} (Telaak Integration)`, fingerprint: "a4:9e:20:7c:1b:f3:58:d2:6a:0e", error: null };
      return null;
    }
    case "add_director": {
      const d = { id: `d-${Date.now().toString(36)}`, name: String(a.name || a.host), host: String(a.host), fingerprint: null,
        mode: (a.mode as AccessMode) ?? "approve", web_api: true, web_api_addr: null, web_api_fingerprint: null };
      config.directors.push(d);
      config.active_director ??= d.id;
      emit("config", config);
      return d;
    }
    case "update_director": {
      const d = config.directors.find((x) => x.id === a.id);
      if (d) {
        if (a.name != null) d.name = String(a.name);
        if (a.host != null) { d.host = String(a.host); d.fingerprint = null; }
        if (a.mode != null) d.mode = a.mode as AccessMode;
        if (a.webApi != null) d.web_api = !!a.webApi;
        if (a.webApiAddr != null) { d.web_api_addr = String(a.webApiAddr).trim() || null; d.web_api_fingerprint = null; }
      }
      emit("config", config);
      return null;
    }
    case "remove_director":
      config.directors = config.directors.filter((d) => d.id !== a.id);
      if (config.active_director === a.id) config.active_director = config.directors[0]?.id ?? null;
      connected.delete(String(a.id));
      emit("config", config);
      return null;
    case "set_active_director":
      config.active_director = String(a.id);
      emit("config", config);
      return null;
    case "forget_fingerprint": {
      const d = config.directors.find((x) => x.id === a.id);
      if (d) d.fingerprint = null;
      connected.delete(String(a.id));
      emit("director", { id: String(a.id), connected: false });
      emit("config", config);
      return null;
    }
    case "connect_director": {
      await sleep(600);
      const id = String(a.id);
      if (!identity.loaded) throw "no client certificate yet — import composer.pem/.key (or a .p12) in Settings";
      const d = config.directors.find((x) => x.id === id);
      if (!d) throw `no Director called “${id}”`;
      if (d.host.endsWith(".local") && d.mode === "read_only") throw `could not reach ${d.host}:5021 (connection timed out)`;
      d.fingerprint ??= "5f:1c:9a:e2:44:0b:8d:37";
      connected.add(id);
      emit("director", { id, connected: true, info: info(id) });
      return { id, mode: d.mode, info: info(id) };
    }
    case "disconnect_director":
      connected.delete(String(a.id));
      emit("director", { id: String(a.id), connected: false });
      return null;
    case "import_identity_files": {
      const paths = (a.paths as string[]) ?? [];
      if (paths.some((p) => /\.(p12|pfx)$/i.test(p)) && !a.password) throw "NEEDS_PASSWORD: that .p12 is password-protected; enter its password";
      if (!paths.some((p) => /\.(pem|crt|cer|p12|pfx)$/i.test(p))) throw `no certificate in ${paths.join(", ")}; choose composer.pem (with composer.key) or a .p12`;
      await sleep(300);
      identity = { loaded: true, label: `${paths[0].split(/[\\/]/).pop()} (Telaak Integration)`, fingerprint: "a4:9e:20:7c:1b:f3:58:d2:6a:0e", error: null };
      return null;
    }
    case "discover_controllers":
      await sleep(1500);
      return SDDP.filter((s) => s.device_type.startsWith("c4:control4_")).concat([
        { host: "c4-core3-000fff445566", address: "192.168.1.11", device_type: "c4:control4_core3:C4-CORE3", manufacturer: "Control4", model: "CORE3", driver: "" },
      ]).map((s) => ({
        kind: "200 OK", primary_proxy: "", proxies: [], config_url: "", max_age: 1800, headers: {}, ...s,
        // The CORE3 plays a secondary controller: no Director of its own.
        director: s.address === "192.168.1.11" ? "disabled" : "connected",
      }));
    case "action":
      return act(String(a.name), (a.args as Args | null) ?? {});
    case "set_ui_context":
      uiContext = a.context as UiContext;
      return null;
    case "approvals":
      return approvals;
    case "decide_approval":
      return decide(String(a.id), !!a.approve, (a.note as string | null) ?? null);
    case "activity":
      return activity;
    case "update_mcp":
      if (a.port != null) config.mcp.port = Number(a.port);
      if (a.lan != null) config.mcp.lan = !!a.lan;
      if (a.newToken) config.mcp.token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
      emit("config", config);
      emit("mcp", mcpStatus());
      return mcpStatus();
    case "update_agent":
      if (a.provider) config.agent.provider = a.provider as Provider;
      if (a.claudePath != null) config.agent.claude_path = String(a.claudePath) || null;
      if (a.codexPath != null) config.agent.codex_path = String(a.codexPath) || null;
      if (a.model != null) config.agent.model = String(a.model) || null;
      emit("config", config);
      return null;
    case "agent_providers":
      await sleep(250);
      return [
        { provider: "claude", installed: true, path: config.agent.claude_path ?? "/Users/you/.local/bin/claude", version: "2.1.40 (Claude Code)" },
        { provider: "codex", installed: !!config.agent.codex_path, path: config.agent.codex_path, version: config.agent.codex_path ? "codex-cli 0.48.0" : null },
      ];
    case "agent_list":
      return [...conversations].sort((x, y) => y.created.localeCompare(x.created));
    case "agent_new": {
      const c: ConversationInfo = { id: `c-${Date.now().toString(36)}`, provider: (a.provider as Provider) ?? config.agent.provider,
        title: "New conversation", created: now(), busy: false, entries: [], cost_usd: 0 };
      conversations.unshift(c);
      return c;
    }
    case "agent_send": {
      const c = conv(String(a.id));
      if (c.busy) throw "still working on the previous message";
      if (c.title === "New conversation") c.title = String(a.text).slice(0, 60);
      c.busy = true;
      push(c, { role: "user", text: String(a.text), at: now() });
      void agentTurn(c, String(a.text));
      return null;
    }
    case "agent_stop": {
      const c = conv(String(a.id));
      c.busy = false;
      const last = c.entries[c.entries.length - 1];
      if (last?.role === "assistant") last.streaming = false;
      push(c, { role: "status", text: "Stopped." });
      return null;
    }
    case "agent_delete": {
      const i = conversations.findIndex((x) => x.id === a.id);
      if (i >= 0) conversations.splice(i, 1);
      return null;
    }
  }
  throw `unknown command ${cmd}`;
}

export async function invoke<T>(cmd: string, args?: Args): Promise<T> {
  await sleep(40 + Math.random() * 80);
  // Cloned both ways, like a real IPC boundary: nothing the UI does to a result reaches this state.
  return structuredClone(await handle(cmd, structuredClone(args ?? {}))) as T;
}
