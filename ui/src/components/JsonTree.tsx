import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

/** Any JSON, as a collapsible tree. For tool inputs and outputs, Director reads and Zigbee
 *  answers — shapes nobody designed for a screen. */
export function JsonTree({ value, name, depth = 0, open: initiallyOpen }: {
  value: unknown; name?: string; depth?: number; open?: boolean;
}) {
  const container = value !== null && typeof value === "object";
  // The first two levels open: the shape is visible at a glance, the bulk is one click away.
  const [open, setOpen] = useState(initiallyOpen ?? depth < 2);
  if (!container) {
    return (
      <div className="jt-row" style={{ paddingLeft: depth * 14 }}>
        {name != null && <span className="jt-key">{name}:</span>}
        <span className={`jt-v jt-${value === null ? "null" : typeof value}`}>{JSON.stringify(value)}</span>
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as object);
  const brackets = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return (
    <div>
      <button className="jt-row jt-toggle" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}
        {name != null && <span className="jt-key">{name}:</span>}
        <span className="jt-dim">{brackets[0]}{!open && ` ${entries.length} ${Array.isArray(value) ? "items" : "keys"} ${brackets[1]}`}</span>
      </button>
      {open && entries.map(([k, v]) => <JsonTree key={k} name={k} value={v} depth={depth + 1} />)}
      {open && <div className="jt-row jt-dim" style={{ paddingLeft: depth * 14 + 14 }}>{brackets[1]}</div>}
    </div>
  );
}
