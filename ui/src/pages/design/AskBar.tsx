import { ArrowUp, ChevronDown, ChevronUp, Eye, MessageSquare, Sparkles, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errText, type ConversationInfo } from "../../api";
import { ApprovalCard } from "../../components/ApprovalCard";
import { Tip } from "../../components/Dialogs";
import { Spinner } from "../../components/controls";
import { Transcript } from "../../components/Transcript";
import { AGENT_SOURCE, approvalFor, proposes, withContext } from "../../lib/agent";
import type { FocusItem, InspectorTab, Shell } from "../../lib/shell";
import { cx, useBackendEvent } from "../../lib/ui";

const TAB_LABEL: Record<InspectorTab, string> = {
  properties: "Properties", connections: "Connections", network: "Network", variables: "Variables", events: "Events",
};

// The Design conversation, for as long as the app runs: every question asked from this bar
// goes to the same one, so "and the other one?" has something to refer to.
let designChat: string | null = null;

/** Ask the agent about what's on screen, or tell it what to change. Each message carries one
 *  line saying what you're looking at; the reply, its tool calls and any approval it is
 *  waiting on show in a panel above the bar. */
export function AskBar({ shell, focus, project }: { shell: Shell; focus: FocusItem | null; project: string }) {
  const [conv, setConv] = useState<ConversationInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Coming back to Design: pick the conversation up where it was.
  useEffect(() => {
    if (!designChat) return;
    api.agentList().then((list) => {
      const c = list.find((x) => x.id === designChat);
      if (c) setConv(c);
      else designChat = null;
    }, () => {});
  }, []);
  useBackendEvent("agent", (c) => { if (c.id === designChat) setConv(c); });

  const tab = shell.inspectorTab;
  const context = focus ? `Design › ${focus.path} (#${focus.id}) · ${TAB_LABEL[tab]}` : "Design";
  const chip = focus ? `${focus.name} · ${TAB_LABEL[tab]}` : project;
  const busy = !!conv?.busy || sending;

  // Only the latest exchange: the whole conversation is one click away in the Agent tab.
  const turn = useMemo(() => {
    const entries = conv?.entries ?? [];
    const i = entries.map((e) => e.role).lastIndexOf("user");
    return i < 0 ? entries : entries.slice(i);
  }, [conv]);
  const started = turn[0]?.role === "user" ? turn[0].at : null;

  // Cards this turn is waiting on that no tool call in it accounts for (a tool this UI doesn't
  // know proposes): still this conversation's, so still shown here.
  const loose = useMemo(() => {
    if (!conv?.busy || !started) return [];
    const claimed = new Set(turn.flatMap((e) => (e.role === "tool" && proposes(e) ? [approvalFor(e, shell.approvals)?.id] : [])));
    return shell.approvals.filter((a) => a.source === AGENT_SOURCE && a.status === "pending" && a.created >= started && !claimed.has(a.id));
  }, [conv, started, turn, shell.approvals]);
  const waiting = useMemo(() => {
    const inTurn = turn.flatMap((e) => (e.role === "tool" && proposes(e) ? [approvalFor(e, shell.approvals)] : []));
    return [...inTurn, ...loose].filter((a) => a?.status === "pending").length;
  }, [turn, loose, shell.approvals]);

  // A card to decide shouldn't wait behind a collapsed panel.
  useEffect(() => { if (waiting) setOpen(true); }, [waiting]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const last = turn[turn.length - 1];
  const signature = `${turn.length}:${last && "text" in last ? last.text.length : 0}:${loose.length}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [signature, open, shell.approvals]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    setOpen(true);
    stick.current = true;
    setSending(true);
    const message = withContext(context, t);
    try {
      try {
        if (!designChat) throw new Error("no conversation yet");
        await api.agentSend(designChat, message);
      } catch (first) {
        // The Design conversation may have been deleted from the Agent tab: start another.
        if (designChat && conv?.busy) throw first;
        const c = await api.agentNew();
        designChat = c.id;
        setConv(c);
        await api.agentSend(c.id, message);
      }
    } catch (e) {
      toast.error(errText(e));
      setText(t);
    } finally {
      setSending(false);
    }
  };

  const stop = () => { if (conv) api.agentStop(conv.id).catch((e) => toast.error(errText(e))); };

  return (
    <div className="ask" onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); } }}>
      {open && conv && (
        <div className="ask-panel" role="region" aria-label="Design assistant">
          <div className="ask-head">
            <Sparkles size={14} strokeWidth={1.8} className="accent" />
            <b>Design assistant</b>
            {busy && <span className="dim small"><Spinner />working</span>}
            <span className="grow" />
            {busy && <Tip text="Stop"><button className="icon-btn" aria-label="Stop" onClick={stop}><Square size={12} strokeWidth={2.2} /></button></Tip>}
            <Tip text="Open in the Agent tab"><button className="icon-btn" aria-label="Open in Agent tab" onClick={() => shell.openChat(conv.id)}>
              <MessageSquare size={14} strokeWidth={1.8} /></button></Tip>
            <Tip text="Collapse (Esc)"><button className="icon-btn" aria-label="Collapse" onClick={() => setOpen(false)}><ChevronDown size={14} strokeWidth={1.8} /></button></Tip>
          </div>
          <div className="ask-scroll" ref={scroller}
               onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
            {turn.length ? <Transcript entries={turn} busy={!!conv.busy} approvals={shell.approvals} />
              : <p className="dim small">Starting the conversation…</p>}
            {loose.map((a) => <div key={a.id} className="msg-card"><ApprovalCard approval={a} /></div>)}
          </div>
        </div>
      )}
      <div className="ask-bar">
        <Tip text={`Sent with your message: ${context}`}>
          <span className="ask-chip"><Eye size={11} strokeWidth={1.8} /><span>{chip}</span></span>
        </Tip>
        <textarea ref={box} rows={1} value={text} aria-label="Ask the agent"
                  placeholder={busy ? "Working… (Stop to interrupt)" : "Ask about this project, or tell me what to change…"}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }} />
        {conv && !open && (
          <Tip text="Show the reply">
            <button className={cx("icon-btn ask-show", waiting > 0 && "on")} aria-label="Show the reply" onClick={() => setOpen(true)}>
              {busy ? <Spinner /> : <ChevronUp size={14} strokeWidth={1.8} />}
            </button>
          </Tip>
        )}
        {busy && conv?.busy ? (
          <Tip text="Stop"><button className="send stop" aria-label="Stop" onClick={stop}><Square size={12} strokeWidth={2.2} /></button></Tip>
        ) : (
          <button className="send" aria-label="Send" disabled={!text.trim() || busy} onClick={() => void send()}><ArrowUp size={15} strokeWidth={2.2} /></button>
        )}
      </div>
    </div>
  );
}
