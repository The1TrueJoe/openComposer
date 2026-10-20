/** Reading the agent's transcript: which approval a `propose_changes` call is waiting on. */

import type { Approval, Entry, Op } from "../api/types.ts";

export const AGENT_SOURCE = "In-app agent";

type ToolEntry = Extract<Entry, { role: "tool" }>;

/** Tool names arrive bare from Claude (the `mcp__openComposer__` prefix is stripped) and may
 *  carry a server prefix from other CLIs. */
export const isTool = (e: ToolEntry, name: string) => e.name === name || e.name.endsWith(`__${name}`) || e.name.endsWith(`.${name}`);

/** Tool input as an object: Codex can hand arguments over as a JSON string. */
export function args(input: unknown): Record<string, unknown> | null {
  if (typeof input === "string") {
    try { return args(JSON.parse(input)); } catch { return null; }
  }
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

/** Whether the ops the agent sent are the ops on a card. The agent may leave out fields that
 *  have defaults (`consumer_name`, `before`), so every field it did send must match, not the
 *  other way round. */
export function sameOps(input: unknown, ops: Op[]): boolean {
  const given = args(input)?.ops;
  if (!Array.isArray(given) || given.length !== ops.length) return false;
  return given.every((g, i) => {
    const want = ops[i] as Record<string, unknown>;
    const o = args(g);
    return !!o && Object.entries(o).every(([k, v]) => JSON.stringify(want[k] ?? null) === JSON.stringify(v ?? null));
  });
}

/** Tools whose call waits on an approval card. */
export const PROPOSING = ["propose_changes", "load_backup", "add_driver", "install_driver"] as const;

export const proposes = (e: ToolEntry) => PROPOSING.some((n) => isTool(e, n));

/** Whether a still-open card is the one this call made. `propose_changes` sends its ops; the
 *  others send a file name the backend turns into ops, so match on that. */
function madeBy(e: ToolEntry, a: Approval): boolean {
  if (isTool(e, "propose_changes")) return sameOps(e.input, a.ops);
  const file = args(e.input)?.filename;
  if (isTool(e, "add_driver")) return a.ops.some((o) => o.op === "add_device" && o.driver === file);
  if (isTool(e, "install_driver")) return a.ops.some((o) => o.op === "install_driver" && o.filename === file);
  return isTool(e, "load_backup") && a.ops.some((o) => o.op === "load_project");
}

/** The card a proposing call is about: by id once the call has returned, otherwise the
 *  newest open agent proposal it matches. */
export function approvalFor(e: ToolEntry, approvals: Approval[]): Approval | null {
  const out = args(e.output);
  const id = typeof out?.approval_id === "string" ? out.approval_id : null;
  if (id) return approvals.find((a) => a.id === id) ?? null;
  return approvals.find((a) => a.source === AGENT_SOURCE && (a.status === "pending" || a.status === "applying") && madeBy(e, a)) ?? null;
}

// The ask bar opens each message with one line saying what the window shows, so the agent can
// resolve "this" without a tool call. On screen that line is a chip, not part of the bubble.
const CONTEXT = /^\[Looking at: (.*)\]\n/;

export const withContext = (context: string | null, text: string) => (context ? `[Looking at: ${context}]\n${text}` : text);

export function splitContext(text: string): { context: string | null; text: string } {
  const m = CONTEXT.exec(text);
  return m ? { context: m[1], text: text.slice(m[0].length) } : { context: null, text };
}

/** A conversation's title without that line. The backend titles a conversation with the first
 *  60 characters of its first message, which for an ask-bar one is mostly the context line. */
export function chatTitle(title: string): string {
  if (!title.startsWith("[Looking at:")) return title;
  const end = title.indexOf("]\n");
  return end >= 0 && title.slice(end + 2).trim() ? title.slice(end + 2) : "Design assistant";
}

/** One line saying what a tool call was asked, for its folded card. */
export function inputSummary(input: unknown): string {
  const a = args(input);
  if (!a) return input == null ? "" : String(input);
  if (Array.isArray(a.ops)) return `${a.ops.length} change${a.ops.length === 1 ? "" : "s"}${typeof a.reason === "string" ? ` — ${a.reason}` : ""}`;
  return Object.entries(a).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" ");
}
