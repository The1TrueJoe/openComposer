/** The small Radix-backed controls every page uses, themed by base.css. */

import * as SelectPrimitive from "@radix-ui/react-select";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { copy } from "../lib/ui";

// Radix reserves "" (it means "cleared"); one sentinel lets callers keep "" as a real value.
const EMPTY = " empty";
const wrap = (v: string) => (v === "" ? EMPTY : v);
const unwrap = (v: string) => (v === EMPTY ? "" : v);

export function Select<T extends string>({ value, onValueChange, options, disabled, label, placeholder }: {
  value: T;
  onValueChange: (v: T) => void;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
  /** For screen readers only — a row's own label already names this control visually. */
  label?: string;
  placeholder?: string;
}) {
  return (
    <SelectPrimitive.Root value={wrap(value)} disabled={disabled} onValueChange={(v) => onValueChange(unwrap(v) as T)}>
      <SelectPrimitive.Trigger className="act select-trigger" aria-label={label}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="select-icon"><ChevronDown size={13} /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="select-content" position="popper" sideOffset={4}>
          <SelectPrimitive.ScrollUpButton className="select-scroll"><ChevronUp size={13} /></SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="select-viewport">
            {options.map((o) => (
              <SelectPrimitive.Item key={o.value} value={wrap(o.value)} disabled={o.disabled} className="select-item">
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="select-indicator"><Check size={13} /></SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="select-scroll"><ChevronDown size={13} /></SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Switch({ checked, onCheckedChange, disabled, label }: {
  checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; label?: string;
}) {
  return (
    <SwitchPrimitive.Root className="switch" checked={checked} disabled={disabled} aria-label={label} onCheckedChange={onCheckedChange}>
      <SwitchPrimitive.Thumb className="switch-thumb" />
    </SwitchPrimitive.Root>
  );
}

/** A row of tabs, one of them on. */
export function Tabs<T extends string>({ tabs, value, onChange, className = "detail-tabs", children }: {
  tabs: readonly { id: T; label: React.ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={className} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" className={value === t.id ? "on" : ""} aria-selected={value === t.id} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
      {children}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="act small" onClick={async () => {
      try {
        await copy(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      } catch {
        toast.error("Couldn't reach the clipboard");
      }
    }}>
      {done ? <Check size={13} strokeWidth={1.8} /> : <Copy size={13} strokeWidth={1.8} />}
      {done ? "Copied" : label}
    </button>
  );
}

/** A snippet to paste somewhere else, with its copy button. `shown` stands in on screen when
 *  the real text holds a secret; the copy is always the real text. */
export function Snippet({ title, text, shown }: { title: string; text: string; shown?: string }) {
  return (
    <div className="snippet">
      <div className="snippet-head"><span>{title}</span><CopyButton text={text} /></div>
      <pre className="mono">{shown ?? text}</pre>
    </div>
  );
}

export function Spinner() {
  return <i className="spin" aria-hidden />;
}
