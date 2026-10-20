import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useRef, useState } from "react";
import { Select } from "../../components/controls";

export interface Room {
  id: number;
  name: string;
  /** Where it is, e.g. "Home › Main House › Main Floor". */
  location: string;
}

interface Ask {
  title: string;
  /** One line under the title: what will happen besides adding (install, identify). */
  description: string;
  name: string;
  room: number | null;
}

/** "Add to room…": which room and what to call it, in one dialog rather than two in a row.
 *  `ask` resolves to the answer, or null however the dialog is dismissed. */
export function useAddToRoom(rooms: Room[]) {
  const [open, setOpen] = useState<Ask | null>(null);
  const [room, setRoom] = useState("");
  const [name, setName] = useState("");
  const resolver = useRef<((v: { room: number; name: string } | null) => void) | null>(null);

  const ask = useCallback((a: Ask) => new Promise<{ room: number; name: string } | null>((resolve) => {
    resolver.current?.(null);
    resolver.current = resolve;
    setRoom(a.room != null ? String(a.room) : "");
    setName(a.name);
    setOpen(a);
  }), []);

  const finish = (v: { room: number; name: string } | null) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpen(null);
  };

  const ok = !!room && !!name.trim();
  const element = (
    <Dialog.Root open={!!open} onOpenChange={(o) => !o && finish(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg" onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.querySelector<HTMLInputElement>("input")?.select();
        }}>
          <Dialog.Title className="dlg-title">{open?.title}</Dialog.Title>
          <Dialog.Description className="dlg-desc">{open?.description}</Dialog.Description>
          <form className="add-form" onSubmit={(e) => { e.preventDefault(); if (ok) finish({ room: Number(room), name: name.trim() }); }}>
            <span className="label">Room</span>
            <Select value={room} onValueChange={setRoom} label="Room" placeholder="Choose a room"
                    options={rooms.map((r) => ({ value: String(r.id), label: r.location ? `${r.name} — ${r.location}` : r.name }))} />
            <span className="label">Name</span>
            <input className="dlg-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <div className="dlg-row">
              <button type="button" className="act" onClick={() => finish(null)}>Cancel</button>
              <button type="submit" className="act primary" disabled={!ok}>Propose</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
  return { ask, element };
}
