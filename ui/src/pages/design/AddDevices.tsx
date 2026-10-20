import { FileUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, errText, type AddDriverArgs } from "../../api";
import { Tip } from "../../components/Dialogs";
import { Tabs } from "../../components/controls";
import { useDropFiles } from "../../lib/drop";
import { baseName, pickFiles } from "../../lib/files";
import type { Shell } from "../../lib/shell";
import { cx, plural, useLoad } from "../../lib/ui";
import { useAddToRoom, type Room } from "./AddToRoom";
import { Discovered } from "./Discovered";
import { DriverSearch, type Query } from "./DriverSearch";
import { fromController, fromLibrary, isDriverFile, type Local } from "./drivers";

/** What "Add to room…" is handed: a driver file, and what to call the device by default. */
export interface AddTarget {
  filename: string;
  name: string;
  manufacturer: string;
  model: string;
}

/** Ask where, then propose the add (and the install and identify it needs) as one card. */
export type Add = (d: AddTarget, opts?: {
  name?: string;
  identify?: AddDriverArgs["identify"];
  /** The device's IP, to say which one it will be identified as. */
  at?: string;
}) => Promise<void>;

type Tab = "discovered" | "drivers";

/** Design's right pane: devices on the network that aren't in the project yet, and every driver
 *  file openComposer can reach — installed on the controller, in the library on this computer,
 *  or in Control4's online database. Adding installs the file first when it's needed (the
 *  backend fetches it from wherever it is). */
export function AddDevices({ shell, room, rooms, focus, onAdded }: {
  shell: Shell;
  /** The room the selection is in: the default for "Add to room…". */
  room: { id: number; name: string } | null;
  rooms: Room[];
  /** Changes when something outside ("Add device" on a room) wants the driver search. */
  focus: number;
  onAdded: (id: number) => void;
}) {
  const [tab, setTab] = useState<Tab>("discovered");
  const [query, setQuery] = useState<Query>({ text: "", type: null });
  const [picked, setPicked] = useState<string | null>(null);
  const [libRev, setLibRev] = useState(0);
  const controller = useLoad(() => api.controllerDrivers(), [shell.rev, shell.director?.id]);
  const library = useLoad(() => api.libraryDrivers(), [libRev]);
  const { ask, element } = useAddToRoom(rooms);

  useEffect(() => { if (focus) setTab("drivers"); }, [focus]);

  const local: Local = useMemo(() => ({
    // Agents aren't put in rooms; they're added on their own (not here yet).
    controller: controller.data ? controller.data.drivers.filter((d) => !d.isAgent).map(fromController) : null,
    library: (library.data?.drivers ?? []).map(fromLibrary),
  }), [controller.data, library.data]);

  const add: Add = useCallback(async (d, opts) => {
    const what = [d.manufacturer, d.model].filter(Boolean).join(" ") || d.name;
    const steps = [opts?.identify && `identified as the device at ${opts.at ?? opts.identify.address}`].filter(Boolean);
    const answer = await ask({
      title: `Add ${d.name}`,
      description: `${d.filename}${steps.length ? `, ${steps.join(", ")}` : ""}. If the controller doesn't have the file yet, installing it (from the library, another Director or Control4's database) is part of the same approval.`,
      name: opts?.name ?? d.name,
      room: room?.id ?? null,
    });
    if (!answer) return;
    const where = rooms.find((r) => r.id === answer.room)?.name ?? `room #${answer.room}`;
    const o = await shell.addDriver({ room: answer.room, filename: d.filename, name: answer.name, identify: opts?.identify, reason: `Add the ${what} to ${where}.` });
    const id = o?.status === "applied" ? o.created_item_ids[0] : undefined;
    if (id != null) onAdded(id);
  }, [ask, onAdded, room, rooms, shell]);

  /** Copy files into the library, then show them there. */
  const importPaths = useCallback(async (paths: string[]) => {
    const files = paths.filter(isDriverFile);
    if (!files.length) {
      if (paths.length) toast.error("Only driver files (.c4z or .c4i) can be imported.");
      return;
    }
    const done: string[] = [];
    for (const p of files) {
      try {
        done.push((await api.importDriver(p)).filename);
      } catch (e) {
        toast.error(`${baseName(p)}: ${errText(e)}`);
      }
    }
    if (!done.length) return;
    setLibRev((n) => n + 1);
    setTab("drivers");
    setQuery({ text: "", type: null });
    setPicked(done[0]);
    toast.success(done.length === 1 ? `${done[0]} is in the library` : `${plural(done.length, "driver file")} are in the library`);
  }, []);

  const pickAndImport = async (expect?: string) => {
    const paths = await pickFiles({ title: expect ? `Choose ${expect}` : "Import driver files", extensions: ["c4z", "c4i"], multiple: !expect, expect });
    await importPaths(paths);
  };

  const drop = useDropFiles(importPaths, isDriverFile);

  return (
    <div ref={drop.ref} className={cx("add-pane", drop.over && "drop-over")} {...drop.handlers}>
      <Tabs className="detail-tabs" value={tab} onChange={setTab}
            tabs={[{ id: "discovered", label: "Discovered" }, { id: "drivers", label: "Drivers" }]}>
        <span className="spread" />
        <Tip text="Import driver files (.c4z, .c4i) into the library — or drop them here">
          <button className="icon-btn" aria-label="Import driver file" onClick={() => void pickAndImport()}><FileUp size={14} strokeWidth={1.8} /></button>
        </Tip>
      </Tabs>
      {tab === "discovered"
        ? <Discovered shell={shell} local={local} add={add}
                      onFind={(type) => { setQuery({ text: "", type }); setPicked(null); setTab("drivers"); }} />
        : <DriverSearch shell={shell} local={local} controllerError={controller.error} query={query} onQuery={setQuery}
                        picked={picked} onPick={setPicked} room={room} add={add} focus={focus}
                        onImport={(filename) => pickAndImport(filename)} />}
      {drop.over && <div className="drop-hint"><FileUp size={22} strokeWidth={1.5} />Drop .c4z or .c4i files to add them to the library</div>}
      {element}
    </div>
  );
}
