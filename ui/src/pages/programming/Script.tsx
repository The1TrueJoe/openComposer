/** One event's script, the way Composer draws it: indented lines with the device each one is
 *  about, disabled lines dimmed, a marker where new lines go. Lines can be selected, removed
 *  and moved (dragged, or a step at a time), and commands dropped between them; the page turns
 *  those into ops. */

import { ArrowDown, ArrowUp, CornerDownRight, GitBranch, Plus, Repeat, Trash2, Zap } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { CodeLineView, TreeNode } from "../../api";
import { Tip } from "../../components/Dialogs";
import { DriverIcon } from "../../components/icons";
import { cx } from "../../lib/ui";
import { flowOf, moveBlocked, slotAt, staysPut, stepMoves, type Place, type Slot } from "./code";

const INDENT = 20;

export function Script({ owner, ownerName, eventName, lines, nodes, selected, onSelect, slot, onSlot, dragging, onDrop, canWrite, why, onDelete, onMove }: {
  owner: TreeNode | null;
  ownerName: string;
  eventName: string;
  lines: CodeLineView[];
  nodes: Map<number, TreeNode>;
  selected: number | null;
  onSelect: (id: number | null) => void;
  slot: Slot;
  onSlot: (s: Slot) => void;
  /** A command is being dragged from Actions: show where it would land. */
  dragging: boolean;
  onDrop: (s: Slot) => void;
  canWrite: boolean;
  /** Why writes are off, when they are. */
  why?: string;
  onDelete: (index: number) => void;
  /** Move line `index` to `to` (remove + add, one approval). */
  onMove: (index: number, to: Place) => void;
}) {
  const [over, setOver] = useState<number | null>(null);
  // The line being dragged to a new place, by row.
  const [moving, setMovingState] = useState<number | null>(null);
  // Read by the drag handlers, which can run before React has re-rendered with the state.
  const movingRef = useRef<number | null>(null);
  const setMoving = (i: number | null) => { movingRef.current = i; setMovingState(i); };
  const box = useRef<HTMLDivElement>(null);
  const active = (dragging || moving != null) && canWrite;
  const live = () => canWrite && (dragging || movingRef.current != null);
  useEffect(() => { if (!dragging && moving == null) setOver(null); }, [dragging, moving]);
  useEffect(() => {
    box.current?.querySelector(".sl.sel")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const shown = active && over != null ? over : slot.index;
  const at = (i: number) => (e: React.DragEvent) => {
    if (!live()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = movingRef.current != null ? "move" : "copy";
    setOver(i);
  };
  // Over a line: above its middle means before it, below means after it.
  const overLine = (i: number) => (e: React.DragEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    at(e.clientY < r.top + r.height / 2 ? i : i + 1)(e);
  };
  const drop = (e: React.DragEvent) => {
    if (!live()) return;
    e.preventDefault();
    const s = slotAt(lines, over ?? slot.index);
    setOver(null);
    if (movingRef.current != null) {
      const i = movingRef.current;
      setMoving(null);
      if (!staysPut(lines, i, s)) onMove(i, s);
      return;
    }
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

  const depthAt = (i: number) => (i < lines.length ? lines[i].depth : 0);
  const gap = (i: number) => (
    <div className={cx("sl-gap", shown === i && "on", active && "drag")} style={{ "--d": depthAt(i) } as React.CSSProperties}
         onClick={() => canWrite && onSlot(slotAt(lines, i))} onDragOver={at(i)} onDrop={drop}
         title={canWrite ? "New lines go here" : undefined}>
      {shown === i && (
        <span className="sl-gap-tag"><CornerDownRight size={11} strokeWidth={2} />{moving != null ? "Move here" : dragging ? "Drop here" : "New lines go here"}</span>
      )}
    </div>
  );

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
        const target = l.target ? nodes.get(l.target) : undefined;
        const Flow = flow?.word && /^(While|Loop|Repeat)$/.test(flow.word) ? Repeat : GitBranch;
        const blocked = moveBlocked(lines, i);
        const steps = blocked ? { up: null, down: null } : stepMoves(lines, i);
        const moveTip = (dir: string) => why ?? blocked ?? `Move this line ${dir} (${dir === "up" ? "⌥↑" : "⌥↓"})`;
        return (
          <Fragment key={l.id}>
            {gap(i)}
            <div className={cx("sl", selected === l.id && "sel", !l.enabled && "off", flow && "flow", moving === i && "moving")} role="listitem"
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
                  {flow ? <Flow size={14} strokeWidth={1.9} /> : <DriverIcon driver={target?.driver} kind={target?.kind ?? "device"} size={15} />}
                </span>
                <span className="sl-text"><LineText text={l.text} word={flow?.word ?? null} name={target?.name} /></span>
                {!l.enabled && <span className="code-off">disabled</span>}
              </span>
              <span className="sl-acts">
                <Tip text={moveTip("up")}>
                  <span><button className="icon-btn" aria-label="Move line up" disabled={!canWrite || !steps.up}
                                onClick={(e) => { e.stopPropagation(); step(i, "up"); }}><ArrowUp size={13} strokeWidth={1.8} /></button></span>
                </Tip>
                <Tip text={moveTip("down")}>
                  <span><button className="icon-btn" aria-label="Move line down" disabled={!canWrite || !steps.down}
                                onClick={(e) => { e.stopPropagation(); step(i, "down"); }}><ArrowDown size={13} strokeWidth={1.8} /></button></span>
                </Tip>
                <Tip text={why ?? "Remove this line (and anything nested under it)"}>
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
        <div className={cx("script-empty", dragging && "drag")} onDragOver={at(0)} onDrop={drop}>
          <Plus size={16} strokeWidth={1.8} />
          <p>Nothing happens on <b>{eventName}</b> yet.</p>
          <p className="dim small">{canWrite ? "Drag a command here from Actions, or pick one there and press Add." : why}</p>
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
