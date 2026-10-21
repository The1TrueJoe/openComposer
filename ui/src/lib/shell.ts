/** What every page is handed by the app shell. Types only. */

import type { AddDriverArgs, AppStatus, Approval, DirectorInfo, KindLabel, Op, Outcome, SavedDirector } from "../api";

export type View = "design" | "network" | "programming" | "agent" | "backups" | "activity" | "settings";

export const INSPECTOR_TABS = ["properties", "connections", "network", "variables", "events"] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

/** The Design selection, resolved against the tree: what "this" means to an assistant. */
export interface FocusItem {
  id: number;
  name: string;
  kind: KindLabel;
  /** "Home › Main House › Main Floor › Living Room › Living TV" — without the project. */
  path: string;
}

export interface Shell {
  status: AppStatus;
  /** The active Director, if one is set up. */
  director: SavedDirector | null;
  /** What it said about itself when it connected. */
  info: DirectorInfo | null;
  connected: boolean;
  /** Writes are allowed (the active Director is in "approve each write" mode). */
  writable: boolean;
  /** Bumped whenever the active project may have changed: pages refetch on it. */
  rev: number;
  approvals: Approval[];
  /** Propose ops as "You"; the approval card opens, and this resolves once it's decided. */
  propose: (ops: Op[], reason?: string) => Promise<Outcome | null>;
  /** Add a device from a driver file (installed first if the controller lacks it, identified
   *  if asked): one approval, resolved once it's decided. */
  addDriver: (a: AddDriverArgs) => Promise<Outcome | null>;
  openApprovals: () => void;
  refreshStatus: () => void;
  go: (view: View) => void;

  /** Design's selection and inspector tab. Held by the app, not the page, so an assistant can
   *  move them (`ui-command`) and they survive switching tabs. */
  selected: number | null;
  select: (id: number | null) => void;
  inspectorTab: InspectorTab;
  setInspectorTab: (tab: InspectorTab) => void;
  /** Design says what the selection resolved to, for the context the app reports. */
  reportFocus: (item: FocusItem | null) => void;
  /** The conversation the Agent tab should show next (set by "Open in Agent tab"). */
  chat: string | null;
  openChat: (id: string) => void;
  /** The event the Programming page shows (set by clicking an event elsewhere). */
  programFocus: ProgramFocus | null;
  /** Open Programming on one device's event. */
  program: (f: ProgramFocus) => void;
}

/** One event to program: `device` owns it (a proxy, for most devices' events). */
export interface ProgramFocus {
  device: number;
  event: number;
}
