/** Composer's Actions pane: pick what a line should do, then add it with the Add button, a
 *  double-click, or by dragging it onto the script. Commands and Conditionals/Loops come from
 *  the device (or agent) picked in the tree — its own and its proxies'; Variables lists the
 *  project's variables. Along the top, Composer's programming controls: Else, Delay, Stop,
 *  Break and comments. */

import { CornerDownRight, GitBranch, GripVertical, Hash, LogOut, OctagonX, Plus, Repeat, Search, Terminal, Timer, Variable } from "lucide-react";
import { useMemo, useState } from "react";
import { api, type TreeNode, type VariableRow } from "../../api";
import { Tip } from "../../components/Dialogs";
import { DriverIcon } from "../../components/icons";
import { BottomPane, Grip, MainPane, Panes } from "../../components/Panes";
import { Loading } from "../../components/shell";
import type { Available } from "../../lib/control";
import { cx, useLoad } from "../../lib/ui";
import { ProjectTree } from "../design/ProjectTree";
import { useCommands, varLabel, withName, type Testable } from "./code";
import { draftLabel, type Draft } from "./Lines";

type Category = "commands" | "conditionals" | "loops" | "variables";

const CATEGORIES = [
  { id: "commands", label: "Commands", icon: Terminal },
  { id: "conditionals", label: "Conditionals", icon: GitBranch },
  { id: "loops", label: "Loops", icon: Repeat },
  { id: "variables", label: "Variables", icon: Variable },
] as const;

const CONTROLS: { d: Draft; icon: typeof Timer; tip: string }[] = [
  { d: { kind: "else" }, icon: CornerDownRight, tip: "Else: what runs when the If above it doesn't. Drop it right below an If's block, or use Add Else on the If." },
  { d: { kind: "delay" }, icon: Timer, tip: "Delay: wait before the next line." },
  { d: { kind: "stop" }, icon: OctagonX, tip: "Stop: end this event's script here." },
  { d: { kind: "break" }, icon: LogOut, tip: "Break: leave the While loop it's in." },
  { d: { kind: "comment" }, icon: Hash, tip: "Comment: a note in the script; it doesn't run." },
];

/** What the pane had open, kept across switching pages. */
const memory: { cat: Category } = { cat: "commands" };

export function Actions({ root, target, onTarget, rev, canAdd, why, onAdd, onDrag }: {
  root: TreeNode | null;
  target: number | null;
  onTarget: (id: number) => void;
  rev: number;
  /** An event is open and the Director takes writes. */
  canAdd: boolean;
  /** Why Add is off, when it is. */
  why?: string;
  onAdd: (d: Draft) => void;
  /** Something picked up (or put down, with null) for dropping on the script. */
  onDrag: (d: Draft | null) => void;
}) {
  const [cat, setCatState] = useState<Category>(memory.cat);
  const setCat = (c: Category) => { memory.cat = c; setCatState(c); };
  const drag = (d: Draft) => ({
    draggable: canAdd,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("text/plain", draftLabel(d)); onDrag(d); },
    onDragEnd: () => onDrag(null),
  });
  return (
    <>
      <div className="prog-cats" role="tablist" aria-label="Kinds of action">
        {CATEGORIES.map((c) => (
          <button key={c.id} role="tab" aria-selected={cat === c.id} className={cx(cat === c.id && "on")} onClick={() => setCat(c.id)}>
            <c.icon size={13} strokeWidth={1.8} />{c.label}
          </button>
        ))}
      </div>
      <div className="prog-ctl" aria-label="Programming controls">
        {CONTROLS.map(({ d, icon: Icon, tip }) => (
          <Tip key={d.kind} text={canAdd ? `${tip} Click to add, or drag onto the script.` : why ?? tip}>
            <button className="prog-ctl-b" disabled={!canAdd} onClick={() => onAdd(d)} {...drag(d)}>
              <Icon size={12} strokeWidth={1.9} />{draftLabel(d)}
            </button>
          </Tip>
        ))}
      </div>
      <div className="prog-fill">
        {cat === "variables" ? (
          <Variables rev={rev} canAdd={canAdd} why={why} onAdd={onAdd} drag={drag} />
        ) : (
          <Panes id="programming-actions" orientation="vertical">
            <MainPane id="targets" minSize={110}>
              <div className="prog-stack">
                {root ? <ProjectTree root={root} sel={target} onSelect={onTarget} onMenu={(e) => e.preventDefault()} onControl={onTarget} />
                  : <Loading what="Reading the project" />}
              </div>
            </MainPane>
            <Grip />
            <BottomPane id="commands" defaultSize="55%" minSize={120}>
              {cat === "commands"
                ? <Commands target={target} node={target != null ? findNode(root, target) : null} rev={rev} canAdd={canAdd} why={why} onAdd={onAdd} drag={drag} />
                : <Tests loop={cat === "loops"} target={target} node={target != null ? findNode(root, target) : null} rev={rev} canAdd={canAdd} why={why} onAdd={onAdd} drag={drag} />}
            </BottomPane>
          </Panes>
        )}
      </div>
    </>
  );
}

type DragProps = (d: Draft) => { draggable: boolean; onDragStart: (e: React.DragEvent) => void; onDragEnd: () => void };

function findNode(root: TreeNode | null, id: number): TreeNode | null {
  if (!root) return null;
  if (root.id === id || root.proxy === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

function Header({ node, target, label, canAdd, why, picked, onAdd }: {
  node: TreeNode | null; target: number; label: string; canAdd: boolean; why?: string; picked: string | null; onAdd: () => void;
}) {
  return (
    <div className="prog-sub">
      <DriverIcon driver={node?.driver} kind={node?.kind ?? "device"} size={14} />
      <span className="prog-sub-name">{node?.name ?? `#${target}`}</span>
      <span className="grow" />
      <Tip text={why ?? (picked ? `Add ${picked} to the script` : `Pick ${label} first`)}>
        <span><button className="act small primary" disabled={!canAdd || !picked} onClick={onAdd}>
          <Plus size={12} strokeWidth={2} />Add
        </button></span>
      </Tip>
    </div>
  );
}

function Commands({ target, node, rev, canAdd, why, onAdd, drag }: {
  target: number | null; node: TreeNode | null; rev: number; canAdd: boolean; why?: string; onAdd: (d: Draft) => void; drag: DragProps;
}) {
  const { available, error, loading } = useCommands(target, rev);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => available.filter((a) => !q || `${a.def.name} ${a.def.description} ${a.targetName}`.toLowerCase().includes(q)), [available, q]);
  const groups = [...new Map(shown.map((a) => [a.target, a])).values()];
  const key = (a: Available) => `${a.target}:${a.def.name}`;
  const pickedA = shown.find((a) => key(a) === picked) ?? null;
  const add = (a: Available) => onAdd({ kind: "command", a });

  if (target == null) return <PickFirst what="Commands" />;
  return (
    <div className="prog-stack">
      <Header node={node} target={target} label="a command" canAdd={canAdd} why={why} picked={pickedA?.def.name ?? null} onAdd={() => pickedA && add(pickedA)} />
      {available.length > 5 && <Filter value={filter} onChange={setFilter} placeholder="Filter commands" />}
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
                     onClick={() => setPicked(key(a))} onDoubleClick={() => canAdd && add(a)}
                     onKeyDown={(e) => { if (e.key === "Enter" && canAdd) add(a); }} {...drag({ kind: "command", a })}>
                  {canAdd && <GripVertical size={12} strokeWidth={1.8} className="pc-grip" />}
                  <span className="pc-main">
                    <span className="pc-name"><span className="mono">{a.def.name}</span>
                      {a.evidence && <Tip text={`Not in a command list; offered because of its ${a.evidence}`}><span className="tag">{a.evidence.split(" ")[0]}</span></Tip>}
                      {a.unsupported && <Tip text={`Declared, but ${a.unsupported}`}><span className="tag warn">not supported</span></Tip>}
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

/** A device's conditionals, as If lines (Conditionals) or While lines (Loops). */
function Tests({ loop, target, node, rev, canAdd, why, onAdd, drag }: {
  loop: boolean; target: number | null; node: TreeNode | null; rev: number; canAdd: boolean; why?: string; onAdd: (d: Draft) => void; drag: DragProps;
}) {
  const { testable, error, loading } = useCommands(target, rev);
  const [picked, setPicked] = useState<string | null>(null);
  const key = (t: Testable) => `${t.target}:${t.def.name}:${t.def.id}`;
  const pickedT = testable.find((t) => key(t) === picked && !t.def.unsupported) ?? null;
  const word = loop ? "While" : "If";
  const add = (t: Testable) => !t.def.unsupported && onAdd({ kind: "test", loop, t });
  const groups = [...new Map(testable.map((t) => [t.target, t])).values()];

  if (target == null) return <PickFirst what={loop ? "Loops" : "Conditionals"} />;
  return (
    <div className="prog-stack">
      <Header node={node} target={target} label="a conditional" canAdd={canAdd} why={why}
              picked={pickedT ? `${word} ${pickedT.def.name}` : null} onAdd={() => pickedT && add(pickedT)} />
      <div className="panel-body pcl" role="listbox" aria-label={loop ? "Loops" : "Conditionals"}>
        {loading && <Loading what="Reading conditionals" />}
        {error && <p className="err small pad">{error}</p>}
        {!loading && !error && !testable.length && (
          <p className="hint prog-hint">{node?.name ?? "This item"} declares nothing an {word} can test. Try its variables (Variables).</p>
        )}
        {groups.map((g) => (
          <div key={g.target}>
            {(groups.length > 1 || g.role !== "device") && <div className="pcl-owner">{g.targetName}<span className="tag">{g.role}</span></div>}
            {testable.filter((t) => t.target === g.target).map((t) => {
              const off = !!t.def.unsupported;
              const text = `${word} ${withName(t.def.description || t.def.name, t.targetName)}`;
              const row = (
                <div key={key(t)} className={cx("pc", picked === key(t) && "sel", off && "off")} role="option" aria-selected={picked === key(t)}
                     aria-disabled={off} tabIndex={0} onClick={() => setPicked(key(t))} onDoubleClick={() => canAdd && add(t)}
                     onKeyDown={(e) => { if (e.key === "Enter" && canAdd) add(t); }} {...(off ? {} : drag({ kind: "test", loop, t }))}>
                  {canAdd && !off && <GripVertical size={12} strokeWidth={1.8} className="pc-grip" />}
                  <span className="pc-main">
                    <span className="pc-name"><span className="mono">{t.def.name || `#${t.def.id}`}</span>
                      {t.def.type && <span className="tag">{t.def.type.toLowerCase()}</span>}</span>
                    <span className="pc-desc" title={text}>{text}</span>
                  </span>
                  {(t.def.logic.length > 0 || t.def.params.length > 0) && <span className="pc-params pc-asks" title="Asks for a comparison or value">…</span>}
                </div>
              );
              return off ? <Tip key={key(t)} text={t.def.unsupported!}>{row}</Tip> : row;
            })}
          </div>
        ))}
      </div>
      <p className="prog-foot dim small">{canAdd ? `Double-click, press Add, or drag onto the script; lines inside the ${word} go in once it's there.` : why}</p>
    </div>
  );
}

/** The project's variables: set one, or test it with an If or While. */
function Variables({ rev, canAdd, why, onAdd, drag }: { rev: number; canAdd: boolean; why?: string; onAdd: (d: Draft) => void; drag: DragProps }) {
  const res = useLoad(() => api.variables(), [rev]);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const all = res.data?.variables ?? [];
  const q = filter.trim().toLowerCase();
  const shown = all.filter((v) => !q || `${v.name} ${v.owner} ${v.type_name}`.toLowerCase().includes(q));
  // The project's own variables first, then by device.
  const owners = [...new Set(shown.map((v) => v.device))].sort((a, b) => Number(b === 100001) - Number(a === 100001));
  const key = (v: VariableRow) => `${v.device}:${v.id}`;
  const pv = shown.find((v) => key(v) === picked) ?? null;
  const acts: { d: Draft; label: string; off: string | null }[] = pv ? [
    { d: { kind: "var-set", v: pv }, label: "Set…", off: pv.readonly ? "Read-only: its driver sets it" : null },
    { d: { kind: "var-test", loop: false, v: pv }, label: "If…", off: null },
    { d: { kind: "var-test", loop: true, v: pv }, label: "While…", off: null },
  ] : [];
  return (
    <div className="prog-stack">
      <Filter value={filter} onChange={setFilter} placeholder="Filter variables" />
      <div className="panel-body pcl" role="listbox" aria-label="Variables">
        {res.loading && !res.data && <Loading what="Reading variables" />}
        {res.error && <p className="err small pad">{res.error}</p>}
        {res.data && !shown.length && <p className="empty pad">{q ? `No variable matches “${filter}”.` : "No variables in this project."}</p>}
        {owners.map((o) => (
          <div key={o}>
            <div className="pcl-owner">{o === 100001 ? "Project variables" : shown.find((v) => v.device === o)?.owner}</div>
            {shown.filter((v) => v.device === o).map((v) => {
              const off = !v.programmable;
              const row = (
                <div key={key(v)} className={cx("pc", picked === key(v) && "sel", off && "off")} role="option" aria-selected={picked === key(v)}
                     aria-disabled={off} tabIndex={0} onClick={() => !off && setPicked(key(v))}>
                  <span className="pc-main">
                    <span className="pc-name"><span className="mono">{v.name}</span><span className="tag">{v.type_name}</span>
                      {v.readonly && <span className="tag">read-only</span>}</span>
                    <span className="pc-desc" title={v.value}>{v.value === "" ? <i>empty</i> : v.value}</span>
                  </span>
                </div>
              );
              return off ? <Tip key={key(v)} text={`${v.type_name} variables can't be programmed here yet`}>{row}</Tip> : row;
            })}
          </div>
        ))}
      </div>
      <div className="prog-var-acts">
        {pv ? <span className="prog-var-name" title={varLabel(pv)}>{varLabel(pv)}</span> : <span className="dim small">Pick a variable to set or test it.</span>}
        {acts.map(({ d, label, off }) => (
          <Tip key={label} text={off ?? why ?? `${label.replace("…", "")} ${pv?.name}: click, or drag onto the script`}>
            <span><button className="act small" disabled={!canAdd || !!off} onClick={() => onAdd(d)} {...(off ? {} : drag(d))}>{label}</button></span>
          </Tip>
        ))}
      </div>
    </div>
  );
}

function Filter({ value, onChange, placeholder }: { value: string; onChange: (s: string) => void; placeholder: string }) {
  return (
    <div className="search-box">
      <Search size={13} strokeWidth={1.8} />
      <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
    </div>
  );
}

function PickFirst({ what }: { what: string }) {
  return (
    <div className="prog-stack">
      <div className="prog-sub">{what}</div>
      <p className="hint prog-hint">Pick a device or agent above to see what it offers.</p>
    </div>
  );
}
