/** Small helpers every pane would otherwise write for itself. No components here. */

import { useCallback, useEffect, useRef, useState } from "react";
import { errText, on, type Events } from "../api";

/** Class names, skipping the ones that are off: `cx("tw-row", sel && "sel")`. */
export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/** A set with one member added or removed. New set, because React state is not mutated. */
export function toggleIn<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** Listen to a backend event for as long as the component is mounted.
 *
 *  The handler is read through a ref so callers can pass an inline closure without
 *  re-subscribing on every render (and missing events in the gap). */
export function useBackendEvent<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    void on(event, (p) => ref.current(p)).then((u) => {
      if (gone) u();
      else off = u;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, [event]);
}

/** Load something, keep showing the last answer while reloading (a project refresh after
 *  every approved change should not blank the pane), and drop answers that arrive out of order. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  // The caller's `deps` decide when `load` is a different question, not `load`'s identity.
  const reload = useCallback(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => { if (n === seq.current) setState({ data, loading: false }); },
      (e) => { if (n === seq.current) setState((s) => ({ data: s.data, error: errText(e), loading: false })); },
    );
  }, deps);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** "3 min ago", for things that happened recently enough that the clock time is noise. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** Whether a key event should be left to the text field it happened in. */
export function typing(e: KeyboardEvent | React.KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl";
