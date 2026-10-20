import { Copy, FolderInput, Gamepad2, MousePointerClick, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type TreeNode } from "../../api";
import { ContextMenu, useContextMenu, type MenuItem } from "../../components/ContextMenu";
import { Tip, useDialog } from "../../components/Dialogs";
import { Grip, MainPane, Panes, SidePane } from "../../components/Panes";
import { Failure, Loading } from "../../components/shell";
import { chain, indexTree, ofKind, parentKindFor } from "../../lib/project";
import type { Shell } from "../../lib/shell";
import { copy, plural, useLoad } from "../../lib/ui";
import { AskBar } from "./AskBar";
import { DeviceControl } from "./DeviceControl";
import { Inspector, type ItemActions } from "./Inspector";
import { ItemsPane } from "./ItemsPane";
import { ProjectTree } from "./ProjectTree";

/** Composer's System Design: the project tree, the selected item, and adding devices — plus
 *  the ask bar, which talks to the agent about whatever is selected. Every change made here
 *  is a proposal: it shows as an approval card before it happens. */
export function DesignPage({ shell }: { shell: Shell }) {
  const tree = useLoad(() => api.tree(), [shell.rev, shell.director?.id]);
  // The app holds the selection, so an assistant can move it and it outlives this page.
  const { selected: sel, select: setSel } = shell;
  // Bumped to put the cursor in the driver search ("Add device" on a room).
  const [findDriver, setFindDriver] = useState(0);
  // The device whose control panel is open.
  const [control, setControl] = useState<number | null>(null);
  const menu = useContextMenu<TreeNode>();
  const { ask, confirm, choose } = useDialog();
  const idx = useMemo(() => indexTree(tree.data?.tree ?? null), [tree.data]);

  const selected = sel != null ? idx.get(sel)?.node ?? null : null;
  // The room the selection is in: where "Add to room…" goes unless you pick another.
  const room = useMemo(() => {
    if (sel == null) return null;
    const r = chain(idx, sel).reverse().find((n) => n.kind === "room");
    return r ? { id: r.id, name: r.name } : null;
  }, [idx, sel]);
  const rooms = useMemo(() => ofKind(idx, "room").map((r) => ({ id: r.node.id, name: r.node.name, location: r.location })), [idx]);

  // What the selection is, for the context the app reports and the ask bar sends.
  const focus = useMemo(() => {
    if (!selected) return null;
    const path = chain(idx, selected.id).slice(1).map((n) => n.name).join(" › ");
    return { id: selected.id, name: selected.name, kind: selected.kind, path };
  }, [idx, selected]);
  const { reportFocus } = shell;
  const focusKey = focus && `${focus.id}|${focus.name}|${focus.kind}|${focus.path}`;
  // Keyed on the text, not the object: a refetched tree with the same item isn't news.
  useEffect(() => reportFocus(focus), [focusKey, reportFocus]);

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
    control: (id) => setControl(id),
  }), [ask, confirm, choose, idx, shell, setSel]);

  const menuItems = (n: TreeNode): MenuItem[] => {
    const w = shell.writable;
    const items: MenuItem[] = [];
    if (n.kind === "device" || n.kind === "proxy") items.push({ label: "Control…", icon: <Gamepad2 size={14} strokeWidth={1.8} />, onSelect: () => setControl(n.id) }, { divider: true });
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
    ? <ProjectTree root={tree.data.tree} sel={sel} onSelect={setSel} onMenu={menu.show} onControl={setControl} />
    : tree.error ? <Failure error={tree.error} retry={tree.reload} /> : <Loading what="Reading the project" />;

  // The path to the selection, as one bar level with the panes' heads.
  const trail = sel != null ? chain(idx, sel) : [];

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
          <div className="design-main">
            <nav className="crumbs" aria-label="Selection">
              {trail.length
                ? trail.map((n, i) => i === trail.length - 1
                    ? <b key={n.id}>{n.name}</b>
                    : <span key={n.id} className="crumb"><button className="link" onClick={() => setSel(n.id)}>{n.name}</button><span className="sep">›</span></span>)
                : <span className="dim">{tree.data?.project ?? "Project"}</span>}
            </nav>
            {selected
              ? <Inspector id={selected.id} shell={shell} onSelect={setSel} actions={actions} />
              : <div className="placeholder"><MousePointerClick size={22} strokeWidth={1.5} /><p>Select a room, device or agent to see its properties, connections and programming. Double-click a device to control it.</p></div>}
            <AskBar shell={shell} focus={focus} project={tree.data?.project ?? "This project"} />
          </div>
        </MainPane>
        <Grip />
        <SidePane id="catalog" side="right" title="Items" defaultSize={340}>
          <ItemsPane shell={shell} idx={idx} sel={sel} room={room} rooms={rooms} focus={findDriver} onAdded={setSel} />
        </SidePane>
      </Panes>
      {menu.open && <ContextMenu x={menu.open.x} y={menu.open.y} items={menuItems(menu.open.target)} onClose={menu.close} />}
      <DeviceControl id={control} shell={shell} onClose={() => setControl(null)} />
    </>
  );
}

function countBelow(n: TreeNode | undefined): number {
  return n ? n.children.reduce((sum, c) => sum + 1 + countBelow(c), 0) : 0;
}
