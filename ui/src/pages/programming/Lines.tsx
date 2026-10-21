/** What can go into a script besides a device command — an If or While on a device's
 *  conditional or a variable, an Else, a variable change, Delay, Stop, Break, a comment — and
 *  the dialog that asks for the values a line needs before it's proposed. The approval card
 *  still follows, with the diff; the backend (crates/c4/src/program.rs) checks it all again
 *  and writes the line's text when the op leaves it empty. */

import * as Dialog from "@radix-ui/react-dialog";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { api, type CommandParam, type Logic, type Op, type VarAction, type VariableRow, type VarRef } from "../../api";
import { Select } from "../../components/controls";
import { initialValue, paramProblem, type Available } from "../../lib/control";
import { useLoad } from "../../lib/ui";
import { conditionText, LOGIC_SYMBOL, LOGIC_WORDS, varLabel, type Testable } from "./code";
import { Field } from "./Params";

/** Something picked in Actions, on its way into the script. */
export type Draft =
  | { kind: "command"; a: Available }
  | { kind: "test"; loop: boolean; t: Testable }
  | { kind: "var-test"; loop: boolean; v: VariableRow }
  | { kind: "var-set"; v: VariableRow }
  | { kind: "else" }
  | { kind: "delay" }
  | { kind: "stop" }
  | { kind: "break" }
  | { kind: "comment" };

type Placed = "device" | "event" | "parent" | "before";
type Adding = Extract<Op, { op: "add_code" | "add_conditional" | "add_else" | "add_control" | "add_variable_command" }>;
/** An add op without its place: what a draft becomes once its values are known. */
export type LineSpec = Adding extends infer O ? (O extends Adding ? Omit<O, Placed> : never) : never;

/** A draft's line, when it needs nothing more (no dialog). */
export function ready(d: Draft): LineSpec | null {
  switch (d.kind) {
    case "else": return { op: "add_else" };
    case "stop": return { op: "add_control", control: { type: "stop" } };
    case "break": return { op: "add_control", control: { type: "break" } };
    case "test":
      if (d.t.def.logic.length || d.t.def.params.length) return null;
      return { op: "add_conditional", loop: d.loop, condition: { type: "device", target: d.t.target, name: d.t.def.name } };
    default: return null;
  }
}

/** A short name for a draft, for drop markers and tooltips. */
export function draftLabel(d: Draft): string {
  switch (d.kind) {
    case "command": return d.a.def.name;
    case "test": return `${d.loop ? "While" : "If"} ${d.t.def.name}`;
    case "var-test": return `${d.loop ? "While" : "If"} ${d.v.name}`;
    case "var-set": return `Set ${d.v.name}`;
    case "else": return "Else";
    case "delay": return "Delay";
    case "stop": return "Stop";
    case "break": return "Break";
    case "comment": return "Comment";
  }
}

/** Asking for a line's values. `ask` is a draft that `ready` can't make on its own (a command
 *  with parameters goes to ParamsDialog instead). */
export function LineDialog({ ask, where, onCancel, onAdd }: {
  ask: Draft | null;
  where: string;
  onCancel: () => void;
  onAdd: (spec: LineSpec) => void;
}) {
  const key = ask ? `${ask.kind}:${"t" in ask ? `${ask.t.target}:${ask.t.def.name}` : "v" in ask ? `${ask.v.device}:${ask.v.id}` : ""}` : "";
  return (
    <Dialog.Root open={!!ask} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg prog-params">
          {ask && <Form key={key} d={ask} where={where} onCancel={onCancel} onAdd={onAdd} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const ALL: Logic[] = ["equal", "not_equal", "less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal"];
const numeric = (t: number) => t === 2 || t === 3;
const logicOptions = (ls: Logic[]) => ls.map((l) => ({ value: l, label: `${LOGIC_SYMBOL[l]}  ${LOGIC_WORDS[l].toLowerCase()}` }));

type FormProps = { where: string; onCancel: () => void; onAdd: (spec: LineSpec) => void };

/** One form per kind of draft, so each keeps its own state (the dialog is keyed by draft). */
function Form({ d, ...rest }: FormProps & { d: Draft }) {
  switch (d.kind) {
    case "test": return <TestForm loop={d.loop} t={d.t} {...rest} />;
    case "var-test": return <VarTestForm loop={d.loop} v={d.v} {...rest} />;
    case "var-set": return <VarSetForm v={d.v} {...rest} />;
    case "delay": return <DelayForm {...rest} />;
    case "comment": return <CommentForm {...rest} />;
    default: return <Frame built={{ title: draftLabel(d), fields: null, preview: draftLabel(d), spec: ready(d), problem: null }} {...rest} />;
  }
}

const TestForm = ({ loop, t, ...rest }: FormProps & { loop: boolean; t: Testable }) => <Frame built={useTest(loop, t)} {...rest} />;
const VarTestForm = ({ loop, v, ...rest }: FormProps & { loop: boolean; v: VariableRow }) => <Frame built={useVarTest(loop, v)} {...rest} />;
const VarSetForm = ({ v, ...rest }: FormProps & { v: VariableRow }) => <Frame built={useVarSet(v)} {...rest} />;
const DelayForm = (rest: FormProps) => <Frame built={useDelay()} {...rest} />;
const CommentForm = (rest: FormProps) => <Frame built={useComment()} {...rest} />;

function Frame({ built, where, onCancel, onAdd }: FormProps & { built: Built }) {
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!built.problem && built.spec) onAdd(built.spec);
  };
  return (
    <form onSubmit={submit}>
      <Dialog.Title className="dlg-title">{built.title}</Dialog.Title>
      <Dialog.Description className="dlg-desc">To {where}. You'll see the change before anything is sent to the Director.</Dialog.Description>
      <div className="pp-fields">{built.fields}</div>
      <div className="pp-preview"><span>{built.preview}</span></div>
      <div className="dlg-row">
        <span className="pp-why err small">{built.problem ?? ""}</span>
        <button type="button" className="act" onClick={onCancel}>Cancel</button>
        <button type="submit" className="act primary" disabled={!!built.problem}><Plus size={13} strokeWidth={2} />Add line</button>
      </div>
    </form>
  );
}

/** A draft's fields, the line it would add, and why it can't be added yet. */
type Built = { title: React.ReactNode; fields: React.ReactNode; preview: string; spec: LineSpec | null; problem: string | null };

function useTest(loop: boolean, t: Testable): Built {
  const def = t.def;
  const [logic, setLogic] = useState<Logic>(def.logic[0] ?? "equal");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(def.params.map((p) => [p.name, initialValue(p)])));
  const params: CommandParam[] = def.params.map((p) => ({ name: p.name, type: "STRING", value: values[p.name] ?? "" }));
  const problem = def.params.map((p) => paramProblem(p, values[p.name] ?? "") ?? ((values[p.name] ?? "") === "" ? `${p.name} needs a value` : null)).find(Boolean) ?? null;
  const lg = def.logic.length ? logic : null;
  return {
    title: <>{loop ? "While" : "If"} <span className="mono">{def.name}</span></>,
    fields: (
      <>
        {def.logic.length > 0 && (
          <div className="pp-field">
            <span className="pp-name"><span className="mono">LOGIC</span><span className="dim small">comparison</span></span>
            <Select value={logic} onValueChange={setLogic} label="Comparison" options={logicOptions(def.logic)} />
          </div>
        )}
        {def.params.map((p) => (
          <Field key={p.name} p={p} value={values[p.name] ?? ""} problem={paramProblem(p, values[p.name] ?? "")}
                 onChange={(v) => setValues((x) => ({ ...x, [p.name]: v }))} />
        ))}
      </>
    ),
    preview: conditionText(loop, def, lg, params, t.targetName),
    spec: { op: "add_conditional", loop, condition: { type: "device", target: t.target, name: def.name, logic: lg, params } },
    problem,
  };
}

/** The project's variables, for "compare with / copy from another variable". */
function useOthers(v: VariableRow) {
  const res = useLoad(() => api.variables(), []);
  return useMemo(() => (res.data?.variables ?? []).filter((x) => x.programmable && !(x.device === v.device && x.id === v.id)), [res.data, v]);
}

const ref = (x: VariableRow): VarRef => ({ device: x.device, id: x.id });
const refKey = (x: VarRef) => `${x.device}:${x.id}`;

function OtherPicker({ others, value, onChange }: { others: VariableRow[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="pp-field">
      <span className="pp-name"><span className="mono">VARIABLE</span><span className="dim small">the other one</span></span>
      <Select value={value} onValueChange={onChange} label="Other variable" placeholder={others.length ? "Pick a variable" : "No other variables"}
              options={others.map((o) => ({ value: refKey(o), label: `${varLabel(o)} (${o.type_name})` }))} />
    </div>
  );
}

function ValueField({ v, value, onChange, label = "VALUE" }: { v: VariableRow; value: string; onChange: (s: string) => void; label?: string }) {
  if (v.type === 4) {
    return (
      <div className="pp-field">
        <span className="pp-name"><span className="mono">{label}</span><span className="dim small">true or false</span></span>
        <Select value={value || "1"} onValueChange={onChange} label={label} options={[{ value: "1", label: "True" }, { value: "0", label: "False" }]} />
      </div>
    );
  }
  const p = { name: label, prop_type: v.type === 2 ? "INTEGER" : v.type === 3 ? "FLOAT" : "STRING", default: null, readonly: false, items: [], minimum: null, maximum: null };
  return <Field p={p} value={value} problem={paramProblem(p, value)} onChange={onChange} />;
}

function valueProblem(v: VariableRow, value: string): string | null {
  if (v.type === 4) return null;
  if (numeric(v.type)) return paramProblem({ name: "VALUE", prop_type: v.type === 2 ? "INTEGER" : "FLOAT", default: null, readonly: false, items: [], minimum: null, maximum: null }, value);
  return null;
}

function useVarTest(loop: boolean, v: VariableRow): Built {
  const others = useOthers(v);
  const logics = numeric(v.type) ? ALL : (["equal", "not_equal"] as Logic[]);
  const [logic, setLogic] = useState<Logic>("equal");
  const [mode, setMode] = useState<"value" | "variable">("value");
  const [value, setValue] = useState(v.type === 4 ? "1" : "");
  const [other, setOther] = useState("");
  const o = others.find((x) => refKey(x) === other);
  const word = loop ? "While" : "If";
  const boolConst = v.type === 4 && mode === "value";
  const preview = mode === "variable"
    ? `${word} ${varLabel(v)} is ${LOGIC_WORDS[logic].toUpperCase()} the value in ${o ? varLabel(o) : "…"}`
    : boolConst ? `${word} ${varLabel(v)} is ${(logic === "equal") === (value === "1") ? "True" : "False"}`
    : `${word} ${varLabel(v)} ${LOGIC_WORDS[logic].toUpperCase()} ${value}`;
  const problem = mode === "variable" ? (o ? null : "Pick the variable to compare with") : valueProblem(v, value);
  return {
    title: <>{word} <span className="mono">{v.name}</span> <span className="dim small">{v.type_name}</span></>,
    fields: (
      <>
        <div className="pp-field">
          <span className="pp-name"><span className="mono">WITH</span><span className="dim small">compare to</span></span>
          <Select value={mode} onValueChange={setMode} label="Compare with" options={[{ value: "value", label: "A value" }, { value: "variable", label: "Another variable" }]} />
        </div>
        <div className="pp-field">
          <span className="pp-name"><span className="mono">LOGIC</span><span className="dim small">comparison</span></span>
          <Select value={logic} onValueChange={setLogic} label="Comparison" options={logicOptions(logics)} />
        </div>
        {mode === "value" ? <ValueField v={v} value={value} onChange={setValue} /> : <OtherPicker others={others} value={other} onChange={setOther} />}
      </>
    ),
    preview,
    spec: { op: "add_conditional", loop, condition: mode === "variable" && o
      ? { type: "variable", variable: ref(v), logic, other: ref(o) }
      : { type: "variable", variable: ref(v), logic, value } },
    problem,
  };
}

type SetKind = VarAction["type"];

function useVarSet(v: VariableRow): Built {
  const others = useOthers(v);
  const kinds: { value: SetKind; label: string }[] = v.type === 4
    ? [{ value: "set", label: "Set to" }, { value: "toggle", label: "Toggle" }, { value: "copy", label: "Copy another variable" }]
    : numeric(v.type)
      ? [{ value: "set", label: "Set to" }, { value: "add", label: "Add" }, { value: "subtract", label: "Subtract" }, { value: "multiply", label: "Multiply by" },
         { value: "divide", label: "Divide by" }, { value: "random", label: "Random number" }, { value: "copy", label: "Copy another variable" }]
      : [{ value: "set", label: "Set to" }, { value: "copy", label: "Copy another variable" }];
  const [kind, setKind] = useState<SetKind>("set");
  const [value, setValue] = useState(v.type === 4 ? "1" : "");
  const [max, setMax] = useState("");
  const [other, setOther] = useState("");
  const o = others.find((x) => refKey(x) === other);
  const me = varLabel(v);
  const sym: Partial<Record<SetKind, string>> = { add: "+", subtract: "-", multiply: "*", divide: "/" };
  let action: VarAction, preview: string, problem: string | null = null;
  switch (kind) {
    case "toggle": action = { type: "toggle" }; preview = `Toggle ${me}`; break;
    case "copy": action = { type: "copy", from: o ? ref(o) : { device: 0, id: 0 } }; preview = `Set ${me} to the value of ${o ? varLabel(o) : "…"}`;
      problem = o ? null : "Pick the variable to copy"; break;
    case "random": action = { type: "random", min: value, max }; preview = `${me} = Random Number Between ${value} and ${max}`;
      problem = valueProblem(v, value) ?? valueProblem(v, max) ?? (value === "" || max === "" ? "Needs a range" : null); break;
    case "set": action = { type: "set", value }; preview = `${me} = ${v.type === 4 ? (value === "1" ? "True" : "False") : value}`;
      problem = valueProblem(v, value); break;
    default: action = { type: kind, value } as VarAction; preview = `${me} = ${me} ${sym[kind]} ${value}`; problem = valueProblem(v, value);
  }
  return {
    title: <>Set <span className="mono">{v.name}</span> <span className="dim small">{v.type_name}</span></>,
    fields: (
      <>
        <div className="pp-field">
          <span className="pp-name"><span className="mono">ACTION</span><span className="dim small">what to do</span></span>
          <Select value={kind} onValueChange={setKind} label="Action" options={kinds} />
        </div>
        {kind === "copy" && <OtherPicker others={others} value={other} onChange={setOther} />}
        {kind === "random" && <><ValueField v={v} value={value} onChange={setValue} label="MIN" /><ValueField v={v} value={max} onChange={setMax} label="MAX" /></>}
        {!["copy", "random", "toggle"].includes(kind) && <ValueField v={v} value={value} onChange={setValue} />}
      </>
    ),
    preview,
    spec: { op: "add_variable_command", variable: ref(v), action },
    problem,
  };
}

const UNITS = [{ value: "1", label: "milliseconds" }, { value: "1000", label: "seconds" }, { value: "60000", label: "minutes" }];

function useDelay(): Built {
  const [n, setN] = useState("5");
  const [unit, setUnit] = useState("1000");
  const count = Number(n);
  const ok = Number.isInteger(count) && count > 0;
  const name = UNITS.find((u) => u.value === unit)!.label;
  return {
    title: "Delay",
    fields: (
      <div className="pp-field">
        <span className="pp-name"><span className="mono">TIME</span><span className="dim small">how long</span></span>
        <span className="pp-num">
          <input className="mono num" value={n} inputMode="numeric" onChange={(e) => setN(e.target.value)} aria-label="Delay length" autoFocus />
          <Select value={unit} onValueChange={setUnit} label="Unit" options={UNITS} />
        </span>
      </div>
    ),
    preview: `delay ${n} ${count === 1 ? name.replace(/s$/, "") : name}`,
    spec: ok ? { op: "add_control", control: { type: "delay", ms: count * Number(unit) } } : null,
    problem: ok ? null : "A whole number above 0",
  };
}

function useComment(): Built {
  const [text, setText] = useState("");
  return {
    title: "Comment",
    fields: (
      <div className="pp-field">
        <span className="pp-name"><span className="mono">TEXT</span><span className="dim small">a note</span></span>
        <input value={text} onChange={(e) => setText(e.target.value)} aria-label="Comment" autoFocus placeholder="What this part does" />
      </div>
    ),
    preview: text || "…",
    spec: text.trim() ? { op: "add_control", control: { type: "comment", text: text.trim() } } : null,
    problem: text.trim() ? null : "Write something",
  };
}
