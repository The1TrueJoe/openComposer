import * as Dialog from "@radix-ui/react-dialog";
import { Bell, X } from "lucide-react";
import type { Approval } from "../api";
import { cx } from "../lib/ui";
import { ApprovalCard } from "./ApprovalCard";

export function ApprovalsBell({ pending, onClick }: { pending: number; onClick: () => void }) {
  return (
    <button className={cx("bell", pending > 0 && "unread")} onClick={onClick}
            title={pending ? `${pending} waiting for approval` : "Approvals"} aria-label={pending ? `${pending} approvals waiting` : "Approvals"}>
      <Bell size={14} strokeWidth={1.8} />
      {pending > 0 && <span className="bell-count">{pending}</span>}
    </button>
  );
}

/** Every proposal, newest first: what is waiting on you at the top, open; the history below,
 *  folded. A sheet over the right edge rather than a page, because it is opened from wherever
 *  you were when the bell rang. */
export function ApprovalsDrawer({ approvals, open, onOpenChange }: {
  approvals: Approval[]; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const live = approvals.filter((a) => a.status === "pending" || a.status === "applying");
  const done = approvals.filter((a) => a.status !== "pending" && a.status !== "applying");
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-scrim" />
        <Dialog.Content className="drawer" aria-describedby={undefined}
                        onOpenAutoFocus={(e) => { if (live.length) e.preventDefault(); }}>
          <div className="drawer-head">
            <Dialog.Title asChild><h2>Approvals</h2></Dialog.Title>
            {live.length > 0 && <span className="tag warn">{live.length} waiting</span>}
            <Dialog.Close className="icon-btn spread" aria-label="Close"><X size={15} strokeWidth={1.8} /></Dialog.Close>
          </div>
          <div className="drawer-body">
            {!approvals.length && <p className="empty pad">Nothing has been proposed yet. Changes from MCP clients, the agent or this app appear here for you to approve.</p>}
            {live.map((a, i) => <ApprovalCard key={a.id} approval={a} autoFocus={i === 0} />)}
            {done.length > 0 && <div className="group">History</div>}
            {done.map((a) => <ApprovalCard key={a.id} approval={a} collapsible />)}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
