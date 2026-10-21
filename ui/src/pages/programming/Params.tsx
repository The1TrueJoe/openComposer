/** Asking for a command's parameters before its line is proposed: one input per parameter,
 *  typed the way the driver declares it, and the line as it will read. Not the approval —
 *  that card still follows, with the diff. */

import * as Dialog from "@radix-ui/react-dialog";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { CommandParam, ParamDef } from "../../api";
import { Select, Switch } from "../../components/controls";
import { DriverIcon } from "../../components/icons";
import { initialValue, paramProblem, paramType, type Available } from "../../lib/control";
import { cx } from "../../lib/ui";
import { displayFor, withName } from "./code";

export function ParamsDialog({ ask, where, onCancel, onAdd }: {
  ask: { a: Available; driver: string | null } | null;
  /** "Living TV › On, at the end" — where the line will go. */
  where: string;
  onCancel: () => void;
  onAdd: (params: CommandParam[]) => void;
}) {
  return (
    <Dialog.Root open={!!ask} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg prog-params">
          {ask && <Form key={`${ask.a.target}:${ask.a.def.name}`} a={ask.a} driver={ask.driver} where={where} onCancel={onCancel} onAdd={onAdd} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Form({ a, driver, where, onCancel, onAdd }: {
  a: Available; driver: string | null; where: string; onCancel: () => void; onAdd: (params: CommandParam[]) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(a.def.params.map((p) => [p.name, initialValue(p)])));
  const params: CommandParam[] = a.def.params.map((p) => ({ name: p.name, type: paramType(p), value: values[p.name] ?? "" }));
  const problems = a.def.params.map((p) => paramProblem(p, values[p.name] ?? ""));
  const bad = problems.find(Boolean);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!bad) onAdd(params);
  };
  return (
    <form onSubmit={submit}>
      <Dialog.Title className="dlg-title">Add <span className="mono">{a.def.name}</span></Dialog.Title>
      <Dialog.Description className="dlg-desc">To {where}. You'll see the change before anything is sent to the Director.</Dialog.Description>
      <div className="pp-fields">
        {a.def.params.map((p, i) => (
          <Field key={p.name} p={p} value={values[p.name] ?? ""} problem={problems[i]}
                 onChange={(v) => setValues((x) => ({ ...x, [p.name]: v }))} />
        ))}
      </div>
      <div className="pp-preview">
        <DriverIcon driver={driver} kind="device" size={15} />
        <span>{withName(displayFor(a.def, params), a.targetName)}</span>
      </div>
      <div className="dlg-row">
        <span className="pp-why err small">{bad ?? ""}</span>
        <button type="button" className="act" onClick={onCancel}>Cancel</button>
        <button type="submit" className="act primary" disabled={!!bad}><Plus size={13} strokeWidth={2} />Add line</button>
      </div>
    </form>
  );
}

/** One parameter, as its type asks: a list is a picker, a range a slider with a number beside it. */
export function Field({ p, value, problem, onChange }: { p: ParamDef; value: string; problem: string | null; onChange: (v: string) => void }) {
  const t = paramType(p);
  const numeric = t.includes("INTEGER") || t.includes("FLOAT") || t === "NUMBER";
  const ranged = numeric && p.minimum != null && p.maximum != null;
  const hint = ranged ? `${p.minimum}–${p.maximum}` : numeric ? (t.includes("FLOAT") ? "number" : "whole number") : t === "LIST" ? "one of the list" : "text";
  let input: React.ReactNode;
  if (t === "LIST" && p.items.length) {
    input = <Select value={value} onValueChange={onChange} label={p.name} options={p.items.map((o) => ({ value: o, label: o }))} />;
  } else if (t === "BOOL" || t === "BOOLEAN") {
    input = <Switch checked={/^(1|true)$/i.test(value)} label={p.name} onCheckedChange={(c) => onChange(c ? "True" : "False")} />;
  } else {
    input = (
      <span className="pp-num">
        {ranged && (
          <input type="range" min={Number(p.minimum)} max={Number(p.maximum)} step={t.includes("FLOAT") ? 0.5 : 1}
                 value={value !== "" && Number.isFinite(Number(value)) ? Number(value) : Number(p.minimum)}
                 onChange={(e) => onChange(e.target.value)} aria-label={`${p.name} slider`} />
        )}
        <input className={cx(numeric && "mono num")} value={value} inputMode={numeric ? "decimal" : undefined} placeholder={hint}
               onChange={(e) => onChange(e.target.value)} aria-label={p.name} autoFocus={!ranged} />
      </span>
    );
  }
  return (
    <div className={cx("pp-field", problem && value !== "" && "bad")}>
      <span className="pp-name"><span className="mono">{p.name}</span><span className="dim small">{hint}</span></span>
      {input}
    </div>
  );
}
