/** Composer's Actions pane: pick the device (or agent) a line should talk to, then one of its
 *  commands — added with the Add button, a double-click, or by dragging it onto the script.
 *  Conditionals, loops and variables are shown, switched off, so the pane has the shape a
 *  Composer user expects; the backend can't write them yet (CLAUDE.md, Known gaps). */

import { GitBranch, GripVertical, Plus, Repeat, Search, Terminal, Variable } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { TreeNode } from "../../api";
import { Tip } from "../../components/Dialogs";
import { DriverIcon } from "../../components/icons";
import { BottomPane, Grip, MainPane, Panes } from "../../components/Panes";
import { Loading } from "../../components/shell";
import type { Available } from "../../lib/control";
import { cx } from "../../lib/ui";
import { ProjectTree } from "../design/ProjectTree";
import { useCommands, withName } from "./code";

const LATER = "Not supported yet: openComposer can add and remove command lines. Conditionals, loops and variables come later.";

const CATEGORIES = [
  { id: "commands", label: "Commands", icon: Terminal, ready: true },
  { id: "conditionals", label: "Conditionals", icon: GitBranch, ready: false },
  { id: "loops", label: "Loops", icon: Repeat, ready: false },
  { id: "variables", label: "Variables", icon: Variable, ready: false },
] as const;

export function Actions({ root, target, onTarget, rev, canAdd, why, onAdd, onDrag }: {
  root: TreeNode | null;
  target: number | null;
  onTarget: (id: number) => void;
  rev: number;
  /** An event is open and the Director takes writes. */
  canAdd: boolean;
  /** Why Add is off, when it is. */
  why?: string;
  onAdd: (a: Available) => void;
  /** A command picked up (or put down, with null) for dropping on the script. */
  onDrag: (a: Available | null) => void;
}) {
  return (
    <>
      <div className="prog-cats" role="tablist" aria-label="Kinds of action">
        {CATEGORIES.map((c) => {
          const btn = (
            <button role="tab" aria-selected={c.ready} className={cx(c.ready && "on")} disabled={!c.ready}>
              <c.icon size={13} strokeWidth={1.8} />{c.label}
            </button>
          );
          return c.ready ? <Fragment key={c.id}>{btn}</Fragment> : <Tip key={c.id} text={LATER}><span>{btn}</span></Tip>;
        })}
      </div>
      <div className="prog-fill">
        <Panes id="programming-actions" orientation="vertical">
          <MainPane id="targets" minSize={110}>
            <div className="prog-stack">
              {root ? <ProjectTree root={root} sel={target} onSelect={onTarget} onMenu={(e) => e.preventDefault()} onControl={onTarget} />
                : <Loading what="Reading the project" />}
            </div>
          </MainPane>
          <Grip />
          <BottomPane id="commands" defaultSize="55%" minSize={120}>
            <Commands target={target} node={target != null ? findNode(root, target) : null} rev={rev} canAdd={canAdd} why={why} onAdd={onAdd} onDrag={onDrag} />
          </BottomPane>
        </Panes>
      </div>
    </>
  );
}


function findNode(root: TreeNode | null, id: number): TreeNode | null {
  if (!root) return null;
  if (root.id === id || root.proxy === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

function Commands({ target, node, rev, canAdd, why, onAdd, onDrag }: {
  target: number | null;
  node: TreeNode | null;
  rev: number;
  canAdd: boolean;
  why?: string;
  onAdd: (a: Available) => void;
  onDrag: (a: Available | null) => void;
}) {
  const { available, error, loading } = useCommands(target, rev);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => available.filter((a) => !q || `${a.def.name} ${a.def.description} ${a.targetName}`.toLowerCase().includes(q)), [available, q]);
  const groups = [...new Map(shown.map((a) => [a.target, a])).values()];
  const key = (a: Available) => `${a.target}:${a.def.name}`;
  const pickedA = shown.find((a) => key(a) === picked) ?? null;

  if (target == null) {
    return (
      <div className="prog-stack">
        <div className="prog-sub">Commands</div>
        <p className="hint prog-hint">Pick a device or agent above to see what it can be told to do.</p>
      </div>
    );
  }
  return (
    <div className="prog-stack">
      <div className="prog-sub">
        <DriverIcon driver={node?.driver} kind={node?.kind ?? "device"} size={14} />
        <span className="prog-sub-name">{node?.name ?? `#${target}`}</span>
        <span className="grow" />
        <Tip text={why ?? (pickedA ? `Add ${pickedA.def.name} to the script` : "Pick a command first")}>
          <span><button className="act small primary" disabled={!canAdd || !pickedA} onClick={() => pickedA && onAdd(pickedA)}>
            <Plus size={12} strokeWidth={2} />Add
          </button></span>
        </Tip>
      </div>
      {available.length > 5 && (
        <div className="search-box">
          <Search size={13} strokeWidth={1.8} />
          <input placeholder="Filter commands" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter commands" />
        </div>
      )}
      <div className="panel-body pcl" role="listbox" aria-label="Commands">
        {loading && <Loading what="Reading commands" />}
        {error && <p className="err small pad">{error}</p>}
        {!loading && !error && !available.length && (
          <p className="hint prog-hint">{node?.name ?? "This item"} declares no commands openComposer can program.</p>
        )}
        {available.length > 0 && !shown.length && <p className="empty pad">No command matches “{filter}”.</p>}
        {groups.map((g) => (
          <div key={g.target}>
            {(groups.length > 1 || g.role !== "device") && (
              <div className="pcl-owner">{g.targetName}<span className="tag">{g.role}</span></div>
            )}
            {shown.filter((a) => a.target === g.target).map((a) => {
              const described = withName(a.def.description.trim() && a.def.description.trim() !== a.def.name ? a.def.description : "", a.targetName);
              return (
                <div key={key(a)} className={cx("pc", picked === key(a) && "sel")} role="option" aria-selected={picked === key(a)} tabIndex={0}
                     draggable={canAdd} onClick={() => setPicked(key(a))} onDoubleClick={() => canAdd && onAdd(a)}
                     onKeyDown={(e) => { if (e.key === "Enter" && canAdd) onAdd(a); }}
                     onDragStart={(e) => { e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("text/plain", a.def.name); onDrag(a); }}
                     onDragEnd={() => onDrag(null)}>
                  {canAdd && <GripVertical size={12} strokeWidth={1.8} className="pc-grip" />}
                  <span className="pc-main">
                    <span className="pc-name"><span className="mono">{a.def.name}</span>
                      {a.standard && <Tip text="Control4's standard command for this proxy type"><span className="tag">standard</span></Tip>}
                    </span>
                    {described && <span className="pc-desc" title={described}>{described}</span>}
                  </span>
                  {a.def.params.length > 0 && <span className="pc-params" title={a.def.params.map((p) => `${p.name} (${p.prop_type || "STRING"})`).join(", ")}>{a.def.params.length}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="prog-foot dim small">{canAdd ? "Double-click, press Add, or drag onto the script." : why}</p>
    </div>
  );
}
