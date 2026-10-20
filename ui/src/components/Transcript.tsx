import { AlertTriangle, Check, ChevronDown, ChevronRight, Eye, Info, Wrench, X } from "lucide-react";
import { memo, useState } from "react";
import type { Approval, Entry } from "../api";
import { approvalFor, inputSummary, proposes, splitContext } from "../lib/agent";
import { cx, time } from "../lib/ui";
import { ApprovalCard } from "./ApprovalCard";
import { JsonTree } from "./JsonTree";
import { Markdown } from "./Markdown";
import { Spinner } from "./controls";

type ToolEntry = Extract<Entry, { role: "tool" }>;

/** One conversation's entries, as chat: the Agent tab's whole conversation, or the ask bar's
 *  latest turn. */
export function Transcript({ entries, busy, approvals }: { entries: Entry[]; busy: boolean; approvals: Approval[] }) {
  return (
    <>
      {entries.map((e, i) => {
        switch (e.role) {
          case "user": {
            const { context, text } = splitContext(e.text);
            return (
              <div key={i} className="msg user">
                {context && <span className="msg-context" title="What the window showed when this was asked"><Eye size={11} strokeWidth={1.8} />{context}</span>}
                <div className="bubble">{text}</div><span className="msg-time">{time(e.at)}</span>
              </div>
            );
          }
          case "assistant":
            return <Assistant key={i} text={e.text} streaming={e.streaming} />;
          case "tool": {
            const pending = e.output == null && busy;
            const card = proposes(e) ? approvalFor(e, approvals) : null;
            return (
              <div key={i} className="msg tool">
                <ToolCall e={e} running={pending} />
                {card && <div className="msg-card"><ApprovalCard approval={card} /></div>}
                {!card && pending && proposes(e) && <p className="dim small pad-x"><Spinner />Preparing the approval card…</p>}
              </div>
            );
          }
          case "status":
            return <div key={i} className="msg status"><Info size={12} strokeWidth={1.8} />{e.text}</div>;
          case "error":
            return <div key={i} className="msg error"><AlertTriangle size={14} strokeWidth={1.8} /><span>{e.text}</span></div>;
        }
      })}
      {busy && entries[entries.length - 1]?.role === "user" && <div className="msg assistant"><span className="typing"><i /><i /><i /></span></div>}
    </>
  );
}

// Memoised: a streaming reply re-renders the whole transcript on every delta, and re-parsing
// every earlier message's markdown each time is what makes long chats stutter.
const Assistant = memo(function Assistant({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className={cx("msg assistant", streaming && "streaming")}>
      <Markdown text={text} />
    </div>
  );
});

function ToolCall({ e, running }: { e: ToolEntry; running: boolean }) {
  const [open, setOpen] = useState(false);
  const state = running ? "running" : e.is_error ? "error" : e.output == null ? "none" : "ok";
  return (
    <div className={cx("tool-card", state, open && "open")}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={13} strokeWidth={1.8} /> : <ChevronRight size={13} strokeWidth={1.8} />}
        <Wrench size={13} strokeWidth={1.8} className="dim" />
        <span className="tool-name">{e.name}</span>
        <span className="tool-sum">{inputSummary(e.input)}</span>
        <span className="tool-state">
          {state === "running" && <Spinner />}
          {state === "ok" && <Check size={13} strokeWidth={1.8} />}
          {state === "error" && <><X size={13} strokeWidth={1.8} />error</>}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="label">Input</div>
          <div className="json"><JsonTree value={e.input} /></div>
          <div className="label">{e.is_error ? "Error" : "Output"}</div>
          <div className="json">
            {e.output == null ? <span className="dim">{running ? "waiting…" : "no output"}</span>
              : typeof e.output === "string" ? <pre className="mono">{e.output}</pre> : <JsonTree value={e.output} />}
          </div>
        </div>
      )}
    </div>
  );
}
