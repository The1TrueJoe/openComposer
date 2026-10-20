/** Driver icons, fetched once per session and shared by every view that draws a device.
 *
 *  The backend answers `driver_icons` with data URLs for the drivers that carry an icon (.c4z
 *  packages); a file it has no icon for is remembered as `null`, so it is asked about once and
 *  then drawn with a generic icon. Requests are batched: a tree of 200 rows is one call. Not
 *  for anything but icons: no components here (`components/icons.tsx` draws them). */

import { useSyncExternalStore } from "react";
import { api } from "../api";

const cache = new Map<string, string | null>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
/** Bumped by `resetDriverIcons`, so an answer for the previous Director is dropped. */
let epoch = 0;

const key = (f: string) => f.toLowerCase();

function notify() {
  version++;
  for (const l of listeners) l();
}

async function flush() {
  timer = null;
  const files = [...queue];
  queue = new Set();
  if (!files.length) return;
  const at = epoch;
  try {
    const { icons } = await api.driverIcons(files);
    if (at !== epoch) return;
    const got = new Map(Object.entries(icons).map(([k, v]) => [key(k), v]));
    for (const f of files) cache.set(key(f), got.get(key(f)) ?? null);
  } catch {
    // No session, no web API, an old backend: generic icons, and don't ask again this session.
    if (at !== epoch) return;
    for (const f of files) cache.set(key(f), null);
  }
  notify();
}

/** Ask for a file's icon if nobody has yet. */
function want(file: string) {
  const k = key(file);
  if (asked.has(k)) return;
  asked.add(k);
  queue.add(file);
  timer ??= setTimeout(() => void flush(), 30);
}

/** The active Director changed: its drivers (and their icons) may differ. */
export function resetDriverIcons() {
  epoch++;
  cache.clear();
  asked.clear();
  queue.clear();
  notify();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The icon for a driver file as a data URL, `null` when it has none (or isn't known yet). */
export function useDriverIcon(file: string | null | undefined): string | null {
  useSyncExternalStore(subscribe, () => version);
  // Only real driver packages can have one; proxies' .c4i files and rooms never do.
  if (!file || !/\.c4z$/i.test(file)) return null;
  const k = key(file);
  if (!cache.has(k)) want(file);
  return cache.get(k) ?? null;
}
