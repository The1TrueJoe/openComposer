/** The controls both agent surfaces share — the Design ask bar and the Agent tab: which CLI,
 *  model and effort a chat runs with (switchable mid-conversation), attachments, the
 *  conversation switcher, and the warning for a chat that started without openComposer's tools. */

import * as Popover from "@radix-ui/react-popover";
import { AlertTriangle, Check, ChevronDown, FileText, History, Image as ImageIcon, MessageSquarePlus, Paperclip, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { api, errText, type ConversationInfo, type Effort, type Provider, type ProviderStatus } from "../api";
import { CLAUDE_MODELS, EFFORTS, PROVIDER_NAMES, chatTitle, modelLabel, type AgentPrefs } from "../lib/agent";
import { baseName, pickFiles } from "../lib/files";
import { ago, cx } from "../lib/ui";
import { Tip } from "./Dialogs";
import { Select, Spinner } from "./controls";

// ---- provider, model, effort -------------------------------------------------------------------

/** The CLIs installed on this computer, asked once per session. */
let providersOnce: Promise<ProviderStatus[]> | null = null;
export function useProviders(): ProviderStatus[] | null {
  const [list, setList] = useState<ProviderStatus[] | null>(null);
  useEffect(() => {
    providersOnce ??= api.agentProviders().catch((e) => { providersOnce = null; throw e; });
    providersOnce.then(setList, () => setList([]));
  }, []);
  return list;
}

/** A pill saying what the chat runs with; opens the settings. `conv` is the chat it applies to
 *  (switching restarts its CLI with the same session); without one it sets the next new chat. */
export function AgentSettings({ conv, prefs, onPrefs, onProvider, compact, align = "end" }: {
  conv: ConversationInfo | null;
  prefs: AgentPrefs;
  onPrefs: (p: Partial<AgentPrefs>) => void;
  /** Picking another CLI: the caller decides what that means for the current chat. */
  onProvider?: (p: Provider) => void;
  compact?: boolean;
  align?: "start" | "end";
}) {
  const providers = useProviders();
  const provider = conv?.provider ?? prefs.provider;
  const model = conv ? conv.model ?? "" : prefs.model;
  const effort = (conv ? conv.effort ?? "" : prefs.effort) as Effort | "";
  const [draft, setDraft] = useState(model);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(model), [model]);
  const list = useId();

  const apply = async (m: string, e: Effort | "") => {
    onPrefs({ model: m, effort: e });
    if (!conv || (m === (conv.model ?? "") && e === (conv.effort ?? ""))) return;
    setBusy(true);
    try {
      await api.agentConfigure(conv.id, m || null, e || null);
    } catch (x) {
      toast.error(errText(x));
      setDraft(conv.model ?? "");
    } finally {
      setBusy(false);
    }
  };

  const label = `${compact ? "" : `${PROVIDER_NAMES[provider].split(" ")[0]} · `}${modelLabel(model, effort)}`;
  return (
    <Popover.Root>
      <Tip text="Agent, model and effort">
        <Popover.Trigger asChild>
          <button className={cx("model-pill", compact && "compact")} aria-label="Agent, model and effort">
            {busy ? <Spinner /> : <SlidersHorizontal size={12} strokeWidth={1.8} />}<span>{label}</span><ChevronDown size={11} strokeWidth={1.8} />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content className="pop agent-pop" align={align} side="top" sideOffset={8} collisionPadding={10}>
          <div className="agent-form">
            <span className="k">Agent</span>
            {providers
              ? <Select value={provider} disabled={!onProvider && !!conv} label="Agent"
                        onValueChange={(p) => { onPrefs({ provider: p }); onProvider?.(p); }}
                        options={providers.map((p) => ({ value: p.provider, disabled: !p.installed,
                          label: p.installed ? `${PROVIDER_NAMES[p.provider]}${p.version ? ` · ${p.version.split(" ")[0]}` : ""}` : `${PROVIDER_NAMES[p.provider]} — not installed` }))} />
              : <Spinner />}
            <span className="k">Model</span>
            <span className="row nowrap">
              <input className="mono" list={list} value={draft} placeholder="default" aria-label="Model" disabled={busy || !!conv?.busy}
                     onChange={(e) => setDraft(e.target.value)} onBlur={() => draft.trim() !== model && void apply(draft.trim(), effort)}
                     onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
              <datalist id={list}>{provider === "claude" && CLAUDE_MODELS.map((m) => <option key={m} value={m} />)}</datalist>
            </span>
            {provider === "claude" && (
              <div className="chips model-chips">
                {CLAUDE_MODELS.map((m) => (
                  <button key={m} className={cx("chip", model === m && "on")} disabled={busy || !!conv?.busy} onClick={() => { setDraft(m); void apply(m, effort); }}>{m}</button>
                ))}
              </div>
            )}
            <span className="k">Effort</span>
            {provider === "claude"
              ? <div className="seg effort">
                  {(["", ...EFFORTS] as (Effort | "")[]).map((x) => (
                    <button key={x || "default"} className={cx("act small", effort === x && "on")} disabled={busy || !!conv?.busy}
                            onClick={() => void apply(model, x)}>{x || "default"}</button>
                  ))}
                </div>
              : <span className="dim small">Codex picks its own.</span>}
          </div>
          <p className="dim small agent-note">
            {conv?.busy ? "Wait for the reply to finish (or stop it) to switch."
              : conv ? "Applies to this chat from the next message: it resumes the same conversation with the new settings."
              : "Used for the next new chat here."}
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---- conversations -------------------------------------------------------------------------------

/** Pick another conversation for this surface, or start a new one. */
export function ConversationSwitcher({ current, onPick, onNew }: {
  current: string | null; onPick: (c: ConversationInfo) => void; onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ConversationInfo[] | null>(null);
  useEffect(() => { if (open) api.agentList().then(setList, (e) => toast.error(errText(e))); }, [open]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip text="Conversations">
        <Popover.Trigger asChild><button className="icon-btn" aria-label="Conversations"><History size={14} strokeWidth={1.8} /></button></Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content className="pop conv-pop" align="end" sideOffset={6} collisionPadding={10}>
          <button className="conv-row new" onClick={() => { setOpen(false); onNew(); }}><MessageSquarePlus size={14} strokeWidth={1.8} />New chat</button>
          <div className="group">Recent</div>
          {!list && <div className="loading small-wait"><Spinner /></div>}
          {list && !list.length && <p className="empty pad">No conversations yet.</p>}
          <div className="conv-list">
            {list?.map((c) => (
              <button key={c.id} className={cx("conv-row", c.id === current && "on")} onClick={() => { setOpen(false); onPick(c); }}>
                <span className="conv-check">{c.id === current && <Check size={13} strokeWidth={1.8} />}</span>
                <span className="conv-text">
                  <span className="conv-title">{c.busy && <Spinner />}{chatTitle(c.title)}</span>
                  <span className="dim small">{PROVIDER_NAMES[c.provider].split(" ")[0]} · {modelLabel(c.model, c.effort)} · {ago(c.created)}{c.tools === 0 ? " · no tools" : ""}</span>
                </span>
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A chat whose CLI started without openComposer's tools can't see the project: say so where
 *  it can't be missed, with the way out. */
export function ToolsMissing({ conv, onNew }: { conv: ConversationInfo | null; onNew: () => void }) {
  if (conv?.tools !== 0) return null;
  const why = [...conv.entries].reverse().find((e) => e.role === "error");
  return (
    <div className="tools-missing" role="alert">
      <AlertTriangle size={16} strokeWidth={1.8} />
      <div>
        <b>This chat can't see your project.</b>
        <span>{why && "text" in why ? why.text : "openComposer's tools didn't load when the agent started."}</span>
      </div>
      <button className="act small primary" onClick={onNew}><MessageSquarePlus size={13} strokeWidth={1.8} />Start a new chat</button>
    </div>
  );
}

// ---- attachments ----------------------------------------------------------------------------------

/** Files to send with the next message: picked or dropped, by absolute path (the backend copies
 *  them where the agent may read them). */
export function useAttachments() {
  const [files, setFiles] = useState<string[]>([]);
  const add = useCallback((paths: string[]) => setFiles((f) => [...f, ...paths.filter((p) => !f.includes(p))]), []);
  const remove = useCallback((p: string) => setFiles((f) => f.filter((x) => x !== p)), []);
  const clear = useCallback(() => setFiles([]), []);
  const pick = useCallback(async () => {
    try {
      add(await pickFiles({ title: "Attach files for the agent", extensions: [], multiple: true }));
    } catch (e) {
      toast.error(errText(e));
    }
  }, [add]);
  return { files, add, remove, clear, pick, set: setFiles };
}

export function AttachButton({ onPick, disabled }: { onPick: () => void; disabled?: boolean }) {
  return (
    <Tip text="Attach files (PDFs, images, text) — or drop them here">
      <button className="icon-btn attach-btn" aria-label="Attach files" disabled={disabled} onClick={onPick}><Paperclip size={14} strokeWidth={1.8} /></button>
    </Tip>
  );
}

const isImage = (p: string) => /\.(png|jpe?g|gif|webp|heic|svg)$/i.test(p);

/** The files waiting to go (removable), or those a sent message carried. */
export function AttachmentChips({ files, onRemove }: { files: string[]; onRemove?: (p: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="attach-chips">
      {files.map((p) => (
        <span key={p} className="chip attach" title={p}>
          {isImage(p) ? <ImageIcon size={11} strokeWidth={1.8} /> : <FileText size={11} strokeWidth={1.8} />}
          <span className="ellip">{baseName(p)}</span>
          {onRemove && <button className="chip-x" aria-label={`Remove ${baseName(p)}`} onClick={() => onRemove(p)}><X size={11} strokeWidth={1.8} /></button>}
        </span>
      ))}
    </div>
  );
}
