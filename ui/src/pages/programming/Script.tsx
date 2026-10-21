/** One event's script, the way Composer draws it: indented lines with the device each one is
 *  about, lines that won't run dimmed, a marker where new lines go. Lines can be selected,
 *  removed, switched off and on, and moved (dragged, or a step at a time); new lines are
 *  dropped between them. Where a drop lands follows the pointer: up and down picks the gap,
 *  left and right how deep — inside the block above, at its end, or after it. The page turns
 *  all of it into ops. */

import {
  ArrowDown, ArrowUp, CornerDownRight, GitBranch, Hash, LogOut, OctagonX, Plus, Power, PowerOff, Repeat, Timer, Trash2, Variable, Zap,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { CodeLineView, LineRole, TreeNode } from "../../api";
import { Tip } from "../../components/Dialogs";
import { DriverIcon } from "../../components/icons";
import { cx } from "../../lib/ui";
import {
  canToggle, elseSlot, flowOf, moveBlocked, moveProblem, offRows, roleOf, slotAtGap, slotProblem, stepMoves, type Place, type Slot,
} from "./code";

const INDENT = 20;
/** Where depth 0's text starts, from the script's left edge (.sl margin + .sl-no + padding). */
const TEXT_LEFT = 16 + 30 + 8;

const ICONS: Partial<Record<LineRole, typeof GitBranch>> = {
  if: GitBranch, while: Repeat, else: CornerDownRight, comment: Hash, delay: Timer, stop: OctagonX, break: LogOut, variable: Variable,
};

export function Script({ owner, ownerName, eventName, lines, nodes, selected, onSelect, slot, onSlot, dragging, onDrop, canWrite, why,
  onDelete, onMove, onToggle, onAddElse }: {
  owner: TreeNode | null;
  ownerName: string;
  eventName: string;
  lines: CodeLineView[];
  nodes: Map<number, TreeNode>;
  selected: number | null;
  onSelect: (id: number | null) => void;
  slot: Slot;
  onSlot: (s: Slot) => void;
  /** Something is being dragged from Actions (an Else, or any other line): show where it would land. */
  dragging: "else" | "line" | null;
  onDrop: (s: Slot) => void;
  canWrite: boolean;
  /** Why writes are off, when they are. */
  why?: string;
  onDelete: (index: number) => void;
  /** Move line `index` to `to` (`move_code`). */
  onMove: (index: number, to: Place) => void;
  onToggle: (index: number) => void;
  /** Add an Else to the If on row `index`. */
  onAddElse: (index: number) => void;
}) {
  const [over, setOver] = useState<Slot | null>(null);
  // The line being dragged to a new place, by row.
  const [moving, setMovingState] = useState<number | null>(null);
  // Read by the drag handlers, which can run before React has re-rendered with the state.
  const movingRef = useRef<number | null>(null);
  const setMoving = (i: number | null) => { movingRef.current = i; setMovingState(i); };
  const box = useRef<HTMLDivElement>(null);
  const active = (!!dragging || moving != null) && canWrite;
  const live = () => canWrite && (!!dragging || movingRef.current != null);
  useEffect(() => { if (!dragging && moving == null) setOver(null); }, [dragging, moving]);
  useEffect(() => {
    box.current?.querySelector(".sl.sel")?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const off = offRows(lines);

  const shown = active && over ? over : slot;
  /** Why the shown marker isn't a place the thing in hand can go ("" = where it already is). */
  const problem = (s: Slot): string | null => {
    if (movingRef.current != null) return moveProblem(lines, movingRef.current, s);
    return slotProblem(lines, s, dragging === "else" ? "else" : "line");
  };
  const shownProblem = active && over ? problem(over) : null;

  const depthFromX = (e: React.DragEvent | React.MouseEvent) => {
    const left = box.current?.getBoundingClientRect().left ?? 0;
    return Math.max(0, Math.round((e.clientX - left - TEXT_LEFT) / INDENT));
  };
  const atGap = (j: number) => (e: React.DragEvent) => {
    if (!live()) return;
    e.preventDefault();
    e.stopPropagation();
    const s = slotAtGap(lines, j, depthFromX(e));
    const p = problem(s);
    e.dataTransfer.dropEffect = p ? "none" : movingRef.current != null ? "move" : "copy";
    if (!over || over.index !== s.index || over.depth !== s.depth) setOver(s);
  };
  // Over a line: above its middle means the gap above it, below means the gap below it.
  const overLine = (i: number) => (e: React.DragEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    atGap(e.clientY < r.top + r.height / 2 ? i : i + 1)(e);
  };
  const drop = (e: React.DragEvent) => {
    if (!live()) return;
    e.preventDefault();
    e.stopPropagation();
    const s = over ?? slot;
    const p = problem(s);
    setOver(null);
    if (movingRef.current != null) {
      const i = movingRef.current;
      setMoving(null);
      if (p == null) onMove(i, { parent: s.parent, before: s.before });
      return;
    }
    if (p) return;
    onSlot(s);
    onDrop(s);
  };

  const step = (i: number, dir: "up" | "down") => {
    if (!canWrite || moveBlocked(lines, i)) return;
    const to = stepMoves(lines, i)[dir];
    if (to) onMove(i, to);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const i = lines.findIndex((l) => l.id === selected);
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey) {
      e.preventDefault();
      if (i >= 0) step(i, e.key === "ArrowUp" ? "up" : "down");
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = lines[Math.max(0, Math.min(lines.length - 1, i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) onSelect(next.id);
    } else if ((e.key === "Delete" || e.key === "Backspace") && i >= 0 && canWrite) {
      e.preventDefault();
      onDelete(i);
    } else if (e.key === "Escape") {
      onSelect(null);
    }
  };

  const gap = (j: number) => {
    const on = shown.index === j;
    const bad = on && shownProblem != null;
    const label = bad ? (shownProblem || "It's here already") : moving != null ? "Move here" : dragging ? "Drop here" : "New lines go here";
    return (
      <div className={cx("sl-gap", on && "on", bad && "bad", active && "drag")} style={{ "--d": on ? shown.depth : (j < lines.length ? lines[j].depth : 0) } as React.CSSProperties}
           onClick={(e) => canWrite && onSlot(slotAtGap(lines, j, depthFromX(e)))} onDragOver={atGap(j)} onDrop={drop}
           title={canWrite ? "New lines go here (left or right for how deep)" : undefined}>
        {on && <span className="sl-gap-tag"><CornerDownRight size={11} strokeWidth={2} />{label}</span>}
      </div>
    );
  };

  return (
    <div className={cx("script", active && "dropping")} ref={box} tabIndex={0} onKeyDown={onKey} role="list"
         aria-label={`${ownerName} › ${eventName}`} onDragLeave={(e) => { if (!box.current?.contains(e.relatedTarget as Node)) setOver(null); }}>
      <div className="script-when">
        <Zap size={13} strokeWidth={2} className="accent" />
        <span className="dim">When</span>
        <span className="script-who"><DriverIcon driver={owner?.driver} kind={owner?.kind ?? "device"} size={15} />{ownerName}</span>
        <b>{eventName}</b>
      </div>
      {lines.map((l, i) => {
        const flow = flowOf(l);
        const role = roleOf(l);
        const target = l.target ? nodes.get(l.target) : undefined;
        const Icon = ICONS[role];
        const blocked = moveBlocked(lines, i);
        const steps = blocked ? { up: null, down: null } : stepMoves(lines, i);
        const moveTip = (dir: string) => why ?? blocked ?? `Move this line ${dir} (${dir === "up" ? "⌥↑" : "⌥↓"})`;
        const toggleable = canToggle(l);
        const elseHere = elseSlot(lines, i);
        return (
          <Fragment key={l.id}>
            {gap(i)}
            <div className={cx("sl", selected === l.id && "sel", off[i] && "off", flow && "flow", `r-${role}`, moving === i && "moving")} role="listitem"
                 aria-selected={selected === l.id} onClick={() => onSelect(l.id)} onDragOver={overLine(i)} onDrop={drop}
                 draggable={canWrite && !blocked}
                 onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", l.text); movingRef.current = i;
                   // Re-rendering the dragged row inside dragstart can cancel the drag in Chromium.
                   setTimeout(() => { setMovingState(i); onSelect(l.id); }); }}
                 onDragEnd={() => setMoving(null)}>
              <span className="sl-no">{i + 1}</span>
              <span className="sl-body" style={{ paddingLeft: 8 + l.depth * INDENT }}>
                {Array.from({ length: l.depth }, (_, k) => <span key={k} className="sl-guide" style={{ left: 15 + k * INDENT }} />)}
                <span className="sl-ic">
                  {Icon ? <Icon size={14} strokeWidth={1.9} /> : <DriverIcon driver={target?.driver} kind={target?.kind ?? "device"} size={15} />}
                </span>
                <span className="sl-text"><LineText text={l.text} word={flow?.word ?? null} name={role === "command" ? target?.name : undefined} /></span>
                {!l.enabled && <span className="code-off">disabled</span>}
              </span>
              <span className="sl-acts">
                {elseHere && (
                  <Tip text={why ?? "Add an Else: what runs when this If doesn't"}>
                    <span><button className="icon-btn" aria-label="Add Else" disabled={!canWrite}
                                  onClick={(e) => { e.stopPropagation(); onAddElse(i); }}><Plus size={13} strokeWidth={1.8} /></button></span>
                  </Tip>
                )}
                {toggleable && (
                  <Tip text={why ?? (l.enabled ? "Disable this line (it stays, but doesn't run)" : "Enable this line")}>
                    <span><button className="icon-btn" aria-label={l.enabled ? "Disable line" : "Enable line"} aria-pressed={!l.enabled} disabled={!canWrite}
                                  onClick={(e) => { e.stopPropagation(); onToggle(i); }}>
                      {l.enabled ? <Power size={13} strokeWidth={1.8} /> : <PowerOff size={13} strokeWidth={1.8} />}
                    </button></span>
                  </Tip>
                )}
                <Tip text={moveTip("up")}>
                  <span><button className="icon-btn" aria-label="Move line up" disabled={!canWrite || !steps.up}
                                onClick={(e) => { e.stopPropagation(); step(i, "up"); }}><ArrowUp size={13} strokeWidth={1.8} /></button></span>
                </Tip>
                <Tip text={moveTip("down")}>
                  <span><button className="icon-btn" aria-label="Move line down" disabled={!canWrite || !steps.down}
                                onClick={(e) => { e.stopPropagation(); step(i, "down"); }}><ArrowDown size={13} strokeWidth={1.8} /></button></span>
                </Tip>
                <Tip text={why ?? (role === "if" ? "Remove this If (with what's inside it, and its Else)" : "Remove this line (and anything nested under it)")}>
                  <span><button className="icon-btn del" aria-label="Remove line" disabled={!canWrite}
                                onClick={(e) => { e.stopPropagation(); onDelete(i); }}><Trash2 size={13} strokeWidth={1.8} /></button></span>
                </Tip>
              </span>
            </div>
          </Fragment>
        );
      })}
      {lines.length > 0 && gap(lines.length)}
      {!lines.length && (
        <div className={cx("script-empty", dragging && "drag")} onDragOver={atGap(0)} onDrop={drop}>
          <Plus size={16} strokeWidth={1.8} />
          <p>Nothing happens on <b>{eventName}</b> yet.</p>
          <p className="dim small">{canWrite ? "Drag a command, conditional or control here from Actions, or pick one there and press Add." : why}</p>
        </div>
      )}
    </div>
  );
}

/** The line's text, with its keyword and the device it's about picked out. */
function LineText({ text, word, name }: { text: string; word: string | null; name?: string }) {
  if (word) return <><span className="sl-kw">{word}</span>{text.trim().slice(word.length)}</>;
  const at = name ? text.indexOf(name) : -1;
  if (!name || at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<span className="sl-dev">{name}</span>{text.slice(at + name.length)}</>;
}
