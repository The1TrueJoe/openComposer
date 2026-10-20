/** MCP clients signing in through the browser: the browser page only waits, and the person
 *  allows or denies the client here. Shown over whatever is on screen (connect screen
 *  included) whenever one is waiting, oldest first. */

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, errText, type AuthRequest } from "../api";
import { useBackendEvent } from "../lib/ui";
import { Spinner } from "./controls";

export function McpAuthPrompt() {
  const [pending, setPending] = useState<AuthRequest[]>([]);
  const [busy, setBusy] = useState(false);

  // Requests made before this window was listening.
  useEffect(() => { api.mcpAuthPending().then(setPending, () => {}); }, []);
  useBackendEvent("mcp-auth", (r) => setPending((l) => (l.some((x) => x.id === r.id) ? l : [...l, r])));
  useBackendEvent("mcp-auth-decided", (d) => setPending((l) => l.filter((x) => x.id !== d.id)));

  const req = pending[0];
  const decide = async (approve: boolean) => {
    if (!req) return;
    setBusy(true);
    try {
      const still = await api.mcpAuthDecide(req.id, approve);
      if (!still) toast.warning(`${req.client_name}'s sign-in isn't waiting any more — it may have timed out. Try connecting again from the client.`);
      else if (approve) toast.success(`${req.client_name} is signed in. Revoke it any time in Settings › MCP.`);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setPending((l) => l.filter((x) => x.id !== req.id));
      setBusy(false);
    }
  };

  return (
    <AlertDialog.Root open={!!req}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dlg-overlay" />
        <AlertDialog.Content className="dlg auth-dlg" onEscapeKeyDown={(e) => { e.preventDefault(); void decide(false); }}>
          {req && <>
            <div className="auth-ic"><KeyRound size={20} strokeWidth={1.8} /></div>
            <AlertDialog.Title className="dlg-title">{req.client_name} wants to connect to openComposer</AlertDialog.Title>
            <AlertDialog.Description className="dlg-desc">
              It will get openComposer's tools: it can read your projects and propose changes. Every change still waits for your approval here.
              Only allow it if you just started signing in from that client.
            </AlertDialog.Description>
            <div className="drv-facts auth-facts">
              <span className="k">Client</span><span>{req.client_name}</span>
              <span className="k">Reached</span><span className="mono">{req.host}</span>
              <span className="k">Returns to</span><span className="mono">{req.redirect_uri}</span>
            </div>
            {pending.length > 1 && <p className="dim small flush-p">{pending.length - 1} more waiting after this one.</p>}
            <div className="dlg-row">
              <button className="act" disabled={busy} onClick={() => void decide(false)}>Deny</button>
              <button className="act primary" disabled={busy} autoFocus onClick={() => void decide(true)}>{busy && <Spinner />}Allow</button>
            </div>
          </>}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
