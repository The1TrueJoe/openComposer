/** Choosing files on disk. The backend reads them itself, so only paths cross over. */

import { isMock } from "../api";

export interface PickOpts {
  title: string;
  extensions: string[];
  multiple?: boolean;
  /** The file name we expect, if there is one (a driver's own file name). */
  expect?: string;
}

/** Paths the user picked, or an empty list if they cancelled. Without Tauri (the browser
 *  mock) there is no native dialog, so a plausible path stands in. */
export async function pickFiles(o: PickOpts): Promise<string[]> {
  if (isMock) return [`/Users/you/Downloads/${o.expect ?? (o.extensions.length ? `composer.${o.extensions[0]}` : "Living Room rack.pdf")}`];
  const { open } = await import("@tauri-apps/plugin-dialog");
  // No extensions: any file (attachments).
  const filters = o.extensions.length ? [{ name: o.extensions.join(", "), extensions: o.extensions }] : undefined;
  const r = await open({ title: o.title, multiple: !!o.multiple, directory: false, filters });
  if (r == null) return [];
  return Array.isArray(r) ? r : [r];
}

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
