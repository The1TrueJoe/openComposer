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

/** The card a `propose_changes` call is about: by id once the call has returned, otherwise
 *  the newest agent proposal with the same ops that is still open. */
export function approvalFor(e: ToolEntry, approvals: Approval[]): Approval | null {
  const out = args(e.output);
  const id = typeof out?.approval_id === "string" ? out.approval_id : null;
  if (id) return approvals.find((a) => a.id === id) ?? null;
  return approvals.find((a) => a.source === AGENT_SOURCE && (a.status === "pending" || a.status === "applying") && sameOps(e.input, a.ops)) ?? null;
}

/** One line saying what a tool call was asked, for its folded card. */
export function inputSummary(input: unknown): string {
  const a = args(input);
  if (!a) return input == null ? "" : String(input);
  if (Array.isArray(a.ops)) return `${a.ops.length} change${a.ops.length === 1 ? "" : "s"}${typeof a.reason === "string" ? ` — ${a.reason}` : ""}`;
  return Object.entries(a).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" ");
}
