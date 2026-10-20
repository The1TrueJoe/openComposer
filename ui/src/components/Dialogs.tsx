import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { createContext, useContext, useMemo, useRef, useState } from "react";
import { cx } from "../lib/ui";

/** A hint that shows in 120ms rather than the browser's second-long `title` delay. */
export function Tip({ text, children, side = "top" }: {
  text: React.ReactNode; children: React.ReactNode; side?: "top" | "right" | "bottom" | "left";
}) {
  if (!text) return <>{children}</>;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" side={side} sideOffset={6} collisionPadding={8}>
          {text}
          <Tooltip.Arrow className="tip-arrow" width={9} height={5} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

type AskOpts = { title: string; description?: string; placeholder?: string; initial?: string; confirmLabel?: string };
type ConfirmOpts = { title: string; description?: string; confirmLabel?: string; danger?: boolean };
type ChooseOpts = {
  title: string;
  description?: string;
  options: { id: string; label: string; detail?: string }[];
};

type Api = {
  /** `prompt()`: resolves to the trimmed text, or null if dismissed. */
  ask: (o: AskOpts) => Promise<string | null>;
  /** `confirm()`, styled as destructive when `danger`. */
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  /** One of a list (a room, a floor…): resolves to the chosen id. Long lists get a filter. */
  choose: (o: ChooseOpts) => Promise<string | null>;
};

const Ctx = createContext<Api>({ ask: async () => null, confirm: async () => false, choose: async () => null });

export function useDialog() {
  return useContext(Ctx);
}

/** `prompt`, `confirm` and a picker as real dialogs: the browser's own are unstyleable and,
 *  inside a webview, sometimes suppressed outright — a "Remove?" that silently answers no. */
export function Dialogs({ children }: { children: React.ReactNode }) {
  const [ask, setAsk] = useState<(AskOpts & { resolve: (v: string | null) => void }) | null>(null);
  const [conf, setConf] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [choice, setChoice] = useState<(ChooseOpts & { resolve: (v: string | null) => void }) | null>(null);
  const [value, setValue] = useState("");
  const [filter, setFilter] = useState("");
  // Held so the caller is answered however the dialog closes — Escape, the overlay or a button.
  // A promise nobody resolves leaves its caller waiting for ever.
  const pending = useRef<(() => void) | null>(null);

  const api = useMemo<Api>(() => ({
    ask: (o) => new Promise((resolve) => {
      setValue(o.initial ?? "");
      pending.current = () => resolve(null);
      setAsk({ ...o, resolve });
    }),
    confirm: (o) => new Promise((resolve) => {
      pending.current = () => resolve(false);
      setConf({ ...o, resolve });
    }),
    choose: (o) => new Promise((resolve) => {
      setFilter("");
      pending.current = () => resolve(null);
      setChoice({ ...o, resolve });
    }),
  }), []);

  const dismiss = () => {
    pending.current?.();
    pending.current = null;
    setAsk(null);
    setConf(null);
    setChoice(null);
  };
  const answer = <T,>(resolve: ((v: T) => void) | undefined, v: T) => {
    pending.current = null;
    resolve?.(v);
    setAsk(null);
    setConf(null);
    setChoice(null);
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = choice?.options ?? [];
    return q ? all.filter((o) => `${o.label} ${o.detail ?? ""}`.toLowerCase().includes(q)) : all;
  }, [choice, filter]);

  return (
    <Ctx.Provider value={api}>
      <Tooltip.Provider delayDuration={120} skipDelayDuration={400}>{children}</Tooltip.Provider>

      <Dialog.Root open={!!ask} onOpenChange={(o) => !o && dismiss()}>
        <Dialog.Portal>
          <Dialog.Overlay className="dlg-overlay" />
          <Dialog.Content className="dlg" onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.querySelector("input")?.select();
          }}>
            <Dialog.Title className="dlg-title">{ask?.title}</Dialog.Title>
            <Dialog.Description className={ask?.description ? "dlg-desc" : "sr-only"}>{ask?.description ?? ask?.title}</Dialog.Description>
            <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) answer(ask?.resolve, value.trim()); }}>
              <input className="dlg-input" value={value} placeholder={ask?.placeholder} onChange={(e) => setValue(e.target.value)} />
              <div className="dlg-row">
                <button type="button" className="act" onClick={dismiss}>Cancel</button>
                <button type="submit" className="act primary" disabled={!value.trim()}>{ask?.confirmLabel ?? "OK"}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AlertDialog.Root open={!!conf} onOpenChange={(o) => !o && dismiss()}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="dlg-overlay" />
          <AlertDialog.Content className="dlg">
            <AlertDialog.Title className="dlg-title">{conf?.title}</AlertDialog.Title>
            <AlertDialog.Description className={conf?.description ? "dlg-desc" : "sr-only"}>{conf?.description ?? conf?.title}</AlertDialog.Description>
            <div className="dlg-row">
              <AlertDialog.Cancel asChild><button className="act" onClick={() => answer(conf?.resolve, false)}>Cancel</button></AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button className={cx("act", conf?.danger ? "danger solid" : "primary")} onClick={() => answer(conf?.resolve, true)}>
                  {conf?.confirmLabel ?? "Confirm"}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <Dialog.Root open={!!choice} onOpenChange={(o) => !o && dismiss()}>
        <Dialog.Portal>
          <Dialog.Overlay className="dlg-overlay" />
          <Dialog.Content className="dlg choose">
            <Dialog.Title className="dlg-title">{choice?.title}</Dialog.Title>
            <Dialog.Description className={choice?.description ? "dlg-desc" : "sr-only"}>{choice?.description ?? choice?.title}</Dialog.Description>
            {(choice?.options.length ?? 0) > 6 && (
              <input className="dlg-input" placeholder="Filter…" value={filter} autoFocus
                     onChange={(e) => setFilter(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Enter" && shown.length === 1) answer(choice?.resolve, shown[0].id); }} />
            )}
            <div className="dlg-choices">
              {shown.map((o) => (
                <button key={o.id} className="dlg-choice" onClick={() => answer(choice?.resolve, o.id)}>
                  <span className="label">{o.label}</span>
                  {o.detail && <span className="sub">{o.detail}</span>}
                </button>
              ))}
              {!shown.length && <p className="empty">Nothing matches.</p>}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Ctx.Provider>
  );
}
