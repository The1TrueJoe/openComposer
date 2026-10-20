/** What every page is handed by the app shell. Types only. */

import type { AppStatus, Approval, DirectorInfo, Op, Outcome, SavedDirector } from "../api";

export type View = "design" | "network" | "programming" | "agent" | "backups" | "activity" | "settings";

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
  /** Put a driver file on the controller (`from`: `path:…`, `backup:…`, `director:…`); also an approval. */
  installDriver: (filename: string, from: string, reason?: string) => Promise<Outcome | null>;
  openApprovals: () => void;
  refreshStatus: () => void;
  go: (view: View) => void;
}
