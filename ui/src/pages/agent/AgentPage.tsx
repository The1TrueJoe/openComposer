import { ArrowUp, MessageSquarePlus, Sparkles, Square, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errText, type ConversationInfo, type Provider } from "../../api";
import { Tip, useDialog } from "../../components/Dialogs";
import { Grip, MainPane, Panes, SidePane } from "../../components/Panes";
import { Select, Spinner } from "../../components/controls";
import { Transcript } from "../../components/Transcript";
import { chatTitle } from "../../lib/agent";
import type { Shell } from "../../lib/shell";
import { ago, cx, useBackendEvent, useLoad } from "../../lib/ui";

const NAMES: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };

const SUGGESTIONS = [
  "What's in the living room, and how is it wired?",
  "Which HDMI inputs aren't connected to anything?",
  "Is anything on the network that isn't in the project yet?",
  "Rename the kitchen lights to Kitchen Pendants",
];

/** The in-app agent: the user's own `claude` or `codex` CLI with openComposer's tools, and
 *  every change it proposes approved right here in the chat. */
export function AgentPage({ shell }: { shell: Shell }) {
  const [convs, setConvs] = useState<ConversationInfo[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const providers = useLoad(() => api.agentProviders(), [shell.status.config.agent]);
  const [provider, setProvider] = useState<Provider>(shell.status.config.agent.provider);
  const { confirm } = useDialog();

  useEffect(() => {
    api.agentList().then((list) => {
      setConvs(list);
      // "Open in Agent tab" from the ask bar names the one to show.
      setSel((s) => s ?? (list.some((c) => c.id === shell.chat) ? shell.chat : list[0]?.id ?? null));
    }, (e) => toast.error(errText(e)));
  }, [shell.chat]);

  useBackendEvent("agent", (c) => setConvs((list) => {
    const i = list.findIndex((x) => x.id === c.id);
    return i < 0 ? [c, ...list] : list.map((x) => (x.id === c.id ? c : x));
  }));

  const current = convs.find((c) => c.id === sel) ?? null;
  const status = providers.data?.find((p) => p.provider === (current?.provider ?? provider));

  const create = async () => {
    try {
      const c = await api.agentNew(provider);
      setConvs((l) => [c, ...l]);
      setSel(c.id);
      return c;
    } catch (e) {
      toast.error(errText(e));
      return null;
    }
  };

  const send = async (text: string) => {
    const c = current ?? (await create());
    if (!c) return false;
    try {
      await api.agentSend(c.id, text);
      return true;
    } catch (e) {
      toast.error(errText(e));
      return false;
    }
  };

  const remove = async (c: ConversationInfo) => {
    if (!(await confirm({ title: `Delete “${chatTitle(c.title)}”?`, description: c.busy ? "It's still working; it will be stopped." : undefined, confirmLabel: "Delete", danger: true }))) return;
    await api.agentDelete(c.id).catch((e) => toast.error(errText(e)));
    setConvs((l) => l.filter((x) => x.id !== c.id));
    if (sel === c.id) setSel(null);
  };

  const providerOptions = (providers.data ?? []).map((p) => ({
    value: p.provider, label: p.installed ? `${NAMES[p.provider]}${p.version ? ` · ${p.version.split(" ")[0]}` : ""}` : `${NAMES[p.provider]} — not installed`,
    disabled: !p.installed,
  }));

  return (
    <Panes id="agent">
      <SidePane id="chats" side="left" title="Conversations" defaultSize={260} minSize={200}>
        <div className="chat-new">
          <button className="act primary" onClick={create}><MessageSquarePlus size={14} strokeWidth={1.8} />New chat</button>
          {providerOptions.length > 0
            ? <Select value={provider} onValueChange={setProvider} options={providerOptions} label="Agent" />
            : <Spinner />}
        </div>
        <div className="panel-body chats">
          {!convs.length && <p className="empty pad">No conversations yet.</p>}
          {convs.map((c) => (
            <div key={c.id} className={cx("chat-item", c.id === sel && "sel")} onClick={() => setSel(c.id)}>
              <div className="chat-title">{c.busy && <Spinner />}{chatTitle(c.title)}</div>
              <div className="chat-meta"><span>{NAMES[c.provider]}</span><span>{ago(c.created)}</span>
                {c.cost_usd > 0 && <span>${c.cost_usd.toFixed(3)}</span>}</div>
              <Tip text="Delete">
                <button className="icon-btn chat-del" aria-label="Delete conversation" onClick={(e) => { e.stopPropagation(); void remove(c); }}>
                  <Trash2 size={13} strokeWidth={1.8} />
                </button>
              </Tip>
            </div>
          ))}
        </div>
      </SidePane>
      <Grip />
      <MainPane id="chat">
        <Chat key={current?.id ?? "new"} conv={current} shell={shell} onSend={send}
              notInstalled={status && !status.installed ? `${NAMES[status.provider]} isn't installed on this computer — install it or set its path in Settings › Agent.` : null} />
      </MainPane>
    </Panes>
  );
}

function Chat({ conv, shell, onSend, notInstalled }: {
  conv: ConversationInfo | null; shell: Shell; onSend: (text: string) => Promise<boolean>; notInstalled: string | null;
}) {
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const busy = !!conv?.busy;
  const last = conv?.entries[conv.entries.length - 1];
  // Follow new output only while the reader is at the bottom; scrolling up to read stops it.
  const signature = useMemo(() => `${conv?.entries.length}:${last && "text" in last ? last.text.length : 0}`, [conv, last]);

  // Grow with what is typed, up to a few lines, then scroll inside.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [signature, shell.approvals]);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    stick.current = true;
    if (!(await onSend(t))) setText(t);
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <Sparkles size={14} strokeWidth={1.8} className="accent" />
        <b>{conv ? chatTitle(conv.title) : "New conversation"}</b>
        {conv && <span className="tag">{NAMES[conv.provider]}</span>}
        <span className="spread" />
        {conv && conv.cost_usd > 0 && <Tip text="Reported by the CLI for this conversation"><span className="dim small">${conv.cost_usd.toFixed(4)}</span></Tip>}
        <span className="dim small">{shell.director ? `on ${shell.director.name}` : "no Director"}</span>
      </div>
      <div className="chat-scroll" ref={scroller}
           onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        <div className="chat-col">
          {!conv?.entries.length ? (
            <div className="chat-empty">
              <Sparkles size={26} strokeWidth={1.4} className="accent" />
              <h2>Ask about this house</h2>
              <p className="dim">The agent reads the project through openComposer's tools. Anything it wants to change shows up here as a diff for you to approve.</p>
              <div className="suggest">
                {SUGGESTIONS.map((s) => <button key={s} className="act" onClick={() => void onSend(s)}>{s}</button>)}
              </div>
            </div>
          ) : <Transcript entries={conv.entries} busy={busy} approvals={shell.approvals} />}
        </div>
      </div>
      <div className="composer">
        {notInstalled && <p className="warn small composer-note">{notInstalled}</p>}
        <div className="composer-box">
          <textarea ref={box} rows={1} placeholder={busy ? "Working… (Stop to interrupt)" : "Message the agent — Enter to send, Shift+Enter for a new line"}
                    value={text} onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void submit();
                      }
                    }} />
          {busy ? (
            <Tip text="Stop"><button className="send stop" aria-label="Stop" onClick={() => conv && api.agentStop(conv.id).catch((e) => toast.error(errText(e)))}>
              <Square size={13} strokeWidth={2.2} /></button></Tip>
          ) : (
            <button className="send" aria-label="Send" disabled={!text.trim()} onClick={() => void submit()}><ArrowUp size={15} strokeWidth={2.2} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
