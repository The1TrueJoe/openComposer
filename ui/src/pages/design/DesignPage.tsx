import { Copy, FolderInput, MousePointerClick, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, type DriverDoc, type TreeNode } from "../../api";
import { ContextMenu, useContextMenu, type MenuItem } from "../../components/ContextMenu";
import { Tip, useDialog } from "../../components/Dialogs";
import { Grip, MainPane, Panes, SidePane } from "../../components/Panes";
import { Failure, Loading } from "../../components/shell";
import { chain, indexTree, ofKind, parentKindFor } from "../../lib/project";
import type { Shell } from "../../lib/shell";
import { baseName, pickFiles } from "../../lib/files";
import { copy, plural, useLoad } from "../../lib/ui";
import { DriverCatalog, type AddDriver } from "./DriverCatalog";
import { Inspector, type ItemActions } from "./Inspector";
import { ProjectTree } from "./ProjectTree";

/** Composer's System Design: the project tree, the selected item, and the driver catalog.
 *  Every change made here is a proposal — it shows as an approval card before it happens. */
export function DesignPage({ shell }: { shell: Shell }) {
  const tree = useLoad(() => api.tree(), [shell.rev, shell.director?.id]);
  const [sel, setSel] = useState<number | null>(null);
  // Bumped to put the cursor in the catalog search ("Add device" on a room).
  const [findDriver, setFindDriver] = useState(0);
  const menu = useContextMenu<TreeNode>();
  const { ask, confirm, choose } = useDialog();
  const idx = useMemo(() => indexTree(tree.data?.tree ?? null), [tree.data]);

  const selected = sel != null ? idx.get(sel)?.node ?? null : null;
  // The room the selection is in, for "Add to <room>" in the catalog.
  const room = useMemo(() => {
    if (sel == null) return null;
    const r = chain(idx, sel).reverse().find((n) => n.kind === "room");
    return r ? { id: r.id, name: r.name } : null;
  }, [idx, sel]);

  const actions: ItemActions = useMemo(() => ({
    rename: async (id, name) => {
      const to = await ask({ title: `Rename “${name}”`, initial: name, confirmLabel: "Propose rename" });
      if (to && to !== name) await shell.propose([{ op: "rename_item", id, name: to }]);
    },
    remove: async (id, name, kind) => {
      const inside = countBelow(idx.get(id)?.node);
      const ok = await confirm({
        title: `Remove ${kind} “${name}”?`,
        description: `${inside ? `${plural(inside, "item")} inside go with it, and so do its connections. ` : "Its connections go with it. "}You'll see the full diff before anything changes.`,
        confirmLabel: "Propose removal", danger: true,
      });
      if (ok) await shell.propose([{ op: "remove_item", id }]);
    },
    move: async (id, name, kind) => {
      const want = parentKindFor(kind);
      if (!want) return;
      const current = idx.get(id)?.parent;
      const targets = ofKind(idx, want).filter((t) => t.node.id !== current);
      const to = await choose({
        title: `Move “${name}” to…`,
        options: targets.map((t) => ({ id: String(t.node.id), label: t.node.name, detail: t.location })),
      });
      if (to) await shell.propose([{ op: "move_item", id, parent: Number(to), before: null }]);
    },
    addRoom: async (floor) => {
      const name = await ask({ title: `New room on “${idx.get(floor)?.node.name}”`, placeholder: "Room name", confirmLabel: "Propose room" });
      if (name) await shell.propose([{ op: "add_room", floor, name }]);
    },
    addDevice: (r) => {
      setSel(r);
      setFindDriver((n) => n + 1);
    },
  }), [ask, confirm, choose, idx, shell]);

  /** Put a driver file on the controller: from a file here, or copied from another Director. */
  const install = useCallback(async (driver: DriverDoc): Promise<boolean> => {
    const others = shell.status.config.directors.filter((x) => x.id !== shell.director?.id);
    let from: string | null = "file";
    if (others.length) {
      from = await choose({
        title: `Install ${driver.filename}`,
        description: "It isn't on this controller yet. Where should the file come from?",
        options: [
          { id: "file", label: "A file on this computer…", detail: "The .c4z or .c4i, e.g. from the manufacturer or the driver database" },
          ...others.map((o) => ({ id: `director:${o.id}`, label: `Copy it from ${o.name}`, detail: o.host })),
        ],
      });
    }
    if (!from) return false;
    if (from === "file") {
      const [path] = await pickFiles({ title: `Choose ${driver.filename}`, extensions: ["c4z", "c4i"], expect: driver.filename });
      if (!path) return false;
      if (baseName(path) !== driver.filename && !(await confirm({
        title: `Install ${baseName(path)} as ${driver.filename}?`,
        description: "The file you picked is named differently from the driver you chose. Devices will refer to it by the driver's name.",
        confirmLabel: "Install anyway",
      }))) return false;
      from = `path:${path}`;
    }
    const o = await shell.installDriver(driver.filename, from, `Needed for the ${driver.manufacturer} ${driver.model}.`);
    return o?.status === "applied";
  }, [choose, confirm, shell]);

  const addDriver: AddDriver = useCallback(async (driver, target, installed) => {
    // Director refuses a device whose driver it doesn't have, with a sentence that doesn't
    // say why; offer the install first instead.
    if (installed === false) {
      const ok = await confirm({ title: `${driver.filename} isn't on this controller`, description: "Install the driver file first, then add the device.", confirmLabel: "Install…" });
      if (!ok || !(await install(driver))) return;
      toast.message(`${driver.filename} is installed — now choose where the device goes.`);
    }
    let roomId = target;
    if (roomId == null) {
      const picked = await choose({
        title: `Add ${driver.name} to…`,
        options: ofKind(idx, "room").map((r) => ({ id: String(r.node.id), label: r.node.name, detail: r.location })),
      });
      if (!picked) return;
      roomId = Number(picked);
    }
    const name = await ask({ title: `Name the new ${driver.name}`, initial: driver.name, confirmLabel: "Propose" });
    if (!name) return;
    const o = await shell.propose([{ op: "add_device", room: roomId, name, driver: driver.filename }],
      `Add ${driver.manufacturer} ${driver.model} to ${idx.get(roomId)?.node.name}.`);
    if (o?.status === "applied" && o.created_item_ids[0] != null) setSel(o.created_item_ids[0]);
  }, [ask, choose, confirm, idx, install, shell]);

  const menuItems = (n: TreeNode): MenuItem[] => {
    const w = shell.writable;
    const items: MenuItem[] = [];
    if (n.kind === "floor") items.push({ label: "Add room…", icon: <Plus size={14} strokeWidth={1.8} />, disabled: !w, onSelect: () => actions.addRoom(n.id) });
    if (n.kind === "room") items.push({ label: "Add device…", icon: <Plus size={14} strokeWidth={1.8} />, disabled: !w, onSelect: () => actions.addDevice(n.id) });
    if (n.kind !== "project") {
      items.push({ label: "Rename…", icon: <Pencil size={14} strokeWidth={1.8} />, disabled: !w, onSelect: () => actions.rename(n.id, n.name) });
      if (parentKindFor(n.kind)) items.push({ label: "Move to…", icon: <FolderInput size={14} strokeWidth={1.8} />, disabled: !w, onSelect: () => actions.move(n.id, n.name, n.kind) });
    }
    items.push({ divider: true }, { label: `Copy id (#${n.id})`, icon: <Copy size={14} strokeWidth={1.8} />, onSelect: () => void copy(String(n.id)) });
    if (n.kind !== "project" && n.kind !== "proxy") {
      items.push({ divider: true }, { label: "Remove…", icon: <Trash2 size={14} strokeWidth={1.8} />, danger: true, disabled: !w, onSelect: () => actions.remove(n.id, n.name, n.kind) });
    }
    return items;
  };

  const treeBody = tree.data?.tree
    ? <ProjectTree root={tree.data.tree} sel={sel} onSelect={setSel} onMenu={menu.show} />
    : tree.error ? <Failure error={tree.error} retry={tree.reload} /> : <Loading what="Reading the project" />;

  return (
    <>
      <Panes id="design">
        <SidePane id="tree" side="left" title={tree.data?.project ?? "Project"} defaultSize={280}
                  actions={<Tip text="Re-read the project"><button className="icon-btn" aria-label="Refresh" onClick={tree.reload}>
                    <RefreshCw size={13} strokeWidth={1.8} className={tree.loading ? "spinning" : ""} /></button></Tip>}>
          {treeBody}
        </SidePane>
        <Grip />
        <MainPane id="inspector">
          {selected
            ? <Inspector id={selected.id} shell={shell} onSelect={setSel} actions={actions} />
            : <div className="placeholder"><MousePointerClick size={22} strokeWidth={1.5} /><p>Select a room, device or agent to see its properties, connections and programming.</p></div>}
        </MainPane>
        <Grip />
        <SidePane id="catalog" side="right" title="Drivers" defaultSize={300}>
          <DriverCatalog room={room} writable={shell.writable} rev={shell.rev} onAdd={addDriver} onInstall={(d) => void install(d)} focus={findDriver} />
        </SidePane>
      </Panes>
      {menu.open && <ContextMenu x={menu.open.x} y={menu.open.y} items={menuItems(menu.open.target)} onClose={menu.close} />}
    </>
  );
}

function countBelow(n: TreeNode | undefined): number {
  return n ? n.children.reduce((sum, c) => sum + 1 + countBelow(c), 0) : 0;
}

