/** The Advanced Lighting agent's own tab, in place of Composer's scene editor: scenes with
 *  the lights in them and what each light does, step by step. Scenes are made, renamed and
 *  removed, and lights added, set and removed, as approvals (*_lighting_scene, set/remove_scene_light). */

import { Lightbulb, Pencil, Plus, Trash2, Type } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { LightColor, LightStep, LightingData, LightingSceneView, NamedRef, Op } from "../../../api";
import { Tip, useDialog } from "../../../components/Dialogs";
import type { Shell } from "../../../lib/shell";
import { cx, plural } from "../../../lib/ui";
import { EditorCard, MultiPick, Ref, ms, useWrites } from "./common";

/** A rough sRGB for a light's colour, for swatches only. */
export function colorCss(c: LightColor): string {
  if ("kelvin" in c) {
    const t = Math.min(1, Math.max(0, (c.kelvin - 2000) / 4500));
    return `color-mix(in srgb, #ffb46b ${Math.round((1 - t) * 100)}%, #dfe8ff)`;
  }
  const s = c.saturation / 100, h = c.hue / 60;
  const x = s * (1 - Math.abs((h % 2) - 1)), m = 1 - s;
  const [r, g, b] = h < 1 ? [s, x, 0] : h < 2 ? [x, s, 0] : h < 3 ? [0, s, x] : h < 4 ? [0, x, s] : h < 5 ? [x, 0, s] : [s, 0, x];
  const to = (v: number) => Math.round((v + m) * 255);
  return `rgb(${to(r)} ${to(g)} ${to(b)})`;
}

const DEFAULT_STEP: LightStep = { delay_ms: 0, level: 100, rate_ms: 1000, color: null };

export function LightingView({ agent, data, shell, onSelect, reload }: {
  agent: { id: number; name: string }; data: LightingData; shell: Shell; onSelect: (id: number) => void; reload: () => void;
}) {
  const dialog = useDialog();
  const w = useWrites(shell, reload);
  const [editing, setEditing] = useState<{ scene: number; light: number } | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const names = data.scenes.map((s) => s.name.trim().toLowerCase());

  const askName = async (title: string, initial = "", own?: string) => {
    const name = await dialog.ask({ title, initial, placeholder: "e.g. Evening", confirmLabel: own ? "Rename" : "Create" });
    if (!name) return null;
    if (name.toLowerCase() !== own?.toLowerCase() && names.includes(name.toLowerCase())) {
      toast.error(`There is already a scene named “${name}”.`);
      return null;
    }
    return name;
  };
  const create = async () => {
    const name = await askName("New lighting scene");
    if (name) await w.propose([{ op: "add_lighting_scene", agent: agent.id, name }], `Add the lighting scene “${name}”.`);
  };
  const rename = async (s: LightingSceneView) => {
    const name = await askName(`Rename “${s.name}”`, s.name, s.name);
    if (name && name !== s.name) await w.propose([{ op: "rename_lighting_scene", agent: agent.id, scene: s.id, name }], `Rename the lighting scene “${s.name}”.`);
  };
  const remove = async (s: LightingSceneView) => {
    const ok = await dialog.confirm({
      title: `Remove “${s.name}”?`,
      description: [s.programmed && `Its programming (${plural(s.programmed, "line")}) goes with it.`,
        s.toggle && `Its toggle scene “${s.toggle.name}” stays.`].filter(Boolean).join(" ") || undefined,
      confirmLabel: "Remove", danger: true,
    });
    if (ok) await w.propose([{ op: "remove_lighting_scene", agent: agent.id, scene: s.id }], `Remove the lighting scene “${s.name}”.`);
  };

  return (
    <div className="ag">
      <div className="ag-bar">
        <span className="dim small">{plural(data.scenes.length, "scene")}</span>
        <span className="spread" />
        <Tip text={w.why ?? "Add a scene"}>
          <span><button className="act small primary" disabled={!w.can} onClick={create}><Plus size={13} strokeWidth={2} />New scene</button></span>
        </Tip>
      </div>
      {!data.scenes.length && <p className="empty pad">No Advanced Lighting scenes yet.</p>}
      {data.scenes.map((s) => (
        <div key={s.id} className="ag-card">
          <div className="ag-card-head">
            <Lightbulb size={14} strokeWidth={1.8} />
            <b>{s.name}</b>
            <span className="dim mono small">#{s.id}</span>
            {s.active && <span className="tag on">active</span>}
            {s.toggle && <span className="tag" title="Its toggle scene">toggles with {s.toggle.name}</span>}
            {!!s.programmed && <span className="tag accent">{plural(s.programmed, "programming line")}</span>}
            <span className="spread" />
            <span className="dim small">{plural(s.members.length, "light")}</span>
            <Tip text={w.why ?? "Add lights"}>
              <span><button className="icon-btn" aria-label="Add lights" disabled={!w.can} onClick={() => setAdding(adding === s.id ? null : s.id)}><Plus size={13} strokeWidth={1.8} /></button></span>
            </Tip>
            <Tip text={w.why ?? "Rename"}>
              <span><button className="icon-btn" aria-label="Rename" disabled={!w.can} onClick={() => rename(s)}><Type size={13} strokeWidth={1.8} /></button></span>
            </Tip>
            <Tip text={w.why ?? "Remove the scene"}>
              <span><button className="icon-btn danger" aria-label="Remove" disabled={!w.can} onClick={() => remove(s)}><Trash2 size={13} strokeWidth={1.8} /></button></span>
            </Tip>
          </div>
          {adding === s.id && (
            <AddLights scene={s} lights={data.lights} busy={w.busy} onCancel={() => setAdding(null)}
              onAdd={async (ids) => {
                const ops: Op[] = ids.map((light) => ({ op: "set_scene_light", agent: agent.id, scene: s.id, light, steps: [DEFAULT_STEP] }));
                if (await w.propose(ops, `Add ${plural(ids.length, "light")} to the lighting scene “${s.name}”.`)) setAdding(null);
              }} />
          )}
          {!!s.members.length && (
            <table className="ag-table">
              <tbody>
                {s.members.map((m) => editing?.scene === s.id && editing.light === m.device.id ? (
                  <tr key={m.device.id}><td colSpan={3} className="ag-cell-edit">
                    <StepsEditor light={m.device} steps={m.steps} busy={w.busy} onCancel={() => setEditing(null)}
                      onSave={async (steps) => {
                        if (await w.propose([{ op: "set_scene_light", agent: agent.id, scene: s.id, light: m.device.id, steps }],
                          `Change what “${m.device.name}” does in the lighting scene “${s.name}”.`)) setEditing(null);
                      }} />
                  </td></tr>
                ) : (
                  <tr key={m.device.id}>
                    <td><Ref r={m.device} onSelect={onSelect} /></td>
                    <td>{m.steps.map((st, i) => <StepText key={i} step={st} />)}</td>
                    <td className="ag-acts"><div>
                      <Tip text={w.why ?? "Change its steps"}>
                        <span><button className="icon-btn" aria-label="Edit" disabled={!w.can} onClick={() => setEditing({ scene: s.id, light: m.device.id })}><Pencil size={13} strokeWidth={1.8} /></button></span>
                      </Tip>
                      <Tip text={w.why ?? "Take it out of the scene"}>
                        <span><button className="icon-btn danger" aria-label="Remove from scene" disabled={!w.can}
                          onClick={() => w.propose([{ op: "remove_scene_light", agent: agent.id, scene: s.id, light: m.device.id }],
                            `Take “${m.device.name}” out of the lighting scene “${s.name}”.`)}><Trash2 size={13} strokeWidth={1.8} /></button></span>
                      </Tip>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

function StepText({ step: st }: { step: LightStep & { text?: string } }) {
  return (
    <span className="ag-step">
      {st.delay_ms > 0 && <span className="dim">after {ms(st.delay_ms)} · </span>}
      {st.level != null && <b>{st.level === 0 ? "off" : `${st.level}%`}</b>}
      {st.color && <span className="ag-swatch" style={{ background: colorCss(st.color) }} />}
      {st.color && <span className="dim">{"kelvin" in st.color ? `${st.color.kelvin} K` : `${st.color.hue}° ${st.color.saturation}%`}</span>}
      <span className="dim"> over {ms(st.rate_ms)}</span>
    </span>
  );
}

function AddLights({ scene, lights, busy, onCancel, onAdd }: {
  scene: LightingSceneView; lights: NamedRef[]; busy: boolean; onCancel: () => void; onAdd: (ids: number[]) => void;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const inScene = new Set(scene.members.map((m) => m.device.id));
  const free = lights.filter((l) => !inScene.has(l.id));
  return (
    <div className="ag-pick">
      <MultiPick options={free} value={picked} onChange={setPicked} empty="Every light is in this scene already." />
      <div className="ag-editor-foot">
        <span className="dim small">Added lights go to 100% over 1 s; change them after.</span>
        <span className="spread" />
        <button type="button" className="act small" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="act small primary" disabled={!picked.length || busy} onClick={() => onAdd(picked)}>
          Add {picked.length ? plural(picked.length, "light") : "lights"}
        </button>
      </div>
    </div>
  );
}

const secs = (msv: number) => +(msv / 1000).toFixed(2);

/** Composer's scene editor for one light: its steps (elements), each with a delay, level,
 *  colour and ramp. */
function StepsEditor({ light, steps: initial, busy, onCancel, onSave }: {
  light: NamedRef; steps: LightStep[]; busy: boolean; onCancel: () => void; onSave: (s: LightStep[]) => void;
}) {
  const [steps, setSteps] = useState<LightStep[]>(() => initial.map(({ delay_ms, level, rate_ms, color }) => ({ delay_ms, level, rate_ms, color })));
  const set = (i: number, patch: Partial<LightStep>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const problem = (() => {
    for (const [i, s] of steps.entries()) {
      const n = steps.length > 1 ? `Step ${i + 1}: ` : "";
      if (s.level == null && s.color == null) return `${n}set a level, a colour or both.`;
      if (s.level != null && (s.level < 0 || s.level > 100)) return `${n}level is 0–100%.`;
      if (s.color && "kelvin" in s.color && (s.color.kelvin < 1000 || s.color.kelvin > 20000)) return `${n}colour temperature is 1000–20000 K.`;
      if (s.rate_ms > 3_600_000 || s.delay_ms > 3_600_000) return `${n}delays and ramps are at most an hour.`;
    }
    return null;
  })();
  return (
    <EditorCard icon={<Lightbulb size={15} strokeWidth={1.8} />} title={light.name} problem={problem} busy={busy} saveLabel="Save"
      onCancel={onCancel} onSave={() => onSave(steps)}>
      {steps.map((s, i) => (
        <StepRow key={i} i={i} n={steps.length} s={s} set={(p) => set(i, p)} remove={() => setSteps((x) => x.filter((_, j) => j !== i))} />
      ))}
      <span />
      <div className="ag-row">
        <button type="button" className="act small" disabled={steps.length >= 20}
          onClick={() => setSteps((x) => [...x, { ...DEFAULT_STEP, delay_ms: 1000, level: 0 }])}><Plus size={13} strokeWidth={2} />Add a step</button>
        <span className="dim small">Steps run in order, each after its delay.</span>
      </div>
    </EditorCard>
  );
}

function StepRow({ i, n, s, set, remove }: { i: number; n: number; s: LightStep; set: (p: Partial<LightStep>) => void; remove: () => void }) {
  const color = s.color;
  const white = !color || "kelvin" in color;
  return (
    <>
      <label>{n > 1 ? `Step ${i + 1}` : "Light"}</label>
      <div className="ag-step-edit">
        {(i > 0 || s.delay_ms > 0) && (
          <div className="ag-row">
            <span className="dim small">after</span>
            <input className="narrow" type="number" min={0} step={0.1} value={secs(s.delay_ms)} aria-label="Delay (s)"
              onChange={(e) => set({ delay_ms: Math.round((Number(e.target.value) || 0) * 1000) })} />
            <span className="dim small">s</span>
          </div>
        )}
        <div className="ag-row">
          <label className="ag-check"><input type="checkbox" checked={s.level != null} onChange={(e) => set({ level: e.target.checked ? 100 : null })} />Level</label>
          {s.level != null && <>
            <input type="range" min={0} max={100} value={s.level} aria-label="Level" onChange={(e) => set({ level: Number(e.target.value) })} />
            <input className="narrow" type="number" min={0} max={100} value={s.level} aria-label="Level (%)" onChange={(e) => set({ level: Number(e.target.value) || 0 })} />
            <span className="dim small">%</span>
          </>}
        </div>
        <div className="ag-row">
          <label className="ag-check"><input type="checkbox" checked={!!color} onChange={(e) => set({ color: e.target.checked ? { kelvin: 3000 } : null })} />Colour</label>
          {color && <>
            <div className="ag-seg" role="radiogroup" aria-label="Colour kind">
              <button type="button" role="radio" aria-checked={white} className={cx(white && "on")} onClick={() => set({ color: { kelvin: 3000 } })}>White</button>
              <button type="button" role="radio" aria-checked={!white} className={cx(!white && "on")} onClick={() => set({ color: { hue: 30, saturation: 80 } })}>Colour</button>
            </div>
            <span className="ag-swatch big" style={{ background: colorCss(color) }} />
            {"kelvin" in color ? <>
              <input type="range" min={2000} max={6500} step={50} value={Math.min(6500, Math.max(2000, color.kelvin))} aria-label="Colour temperature"
                onChange={(e) => set({ color: { kelvin: Number(e.target.value) } })} />
              <input className="narrow wide" type="number" min={1000} max={20000} step={10} value={color.kelvin} aria-label="Kelvin"
                onChange={(e) => set({ color: { kelvin: Number(e.target.value) || 0 } })} />
              <span className="dim small">K</span>
            </> : <>
              <input type="range" className="ag-hue" min={0} max={359} value={color.hue} aria-label="Hue" onChange={(e) => set({ color: { ...color, hue: Number(e.target.value) } })} />
              <input className="narrow" type="number" min={0} max={100} value={color.saturation} aria-label="Saturation (%)"
                onChange={(e) => set({ color: { ...color, saturation: Math.max(0, Math.min(100, Number(e.target.value) || 0)) } })} />
              <span className="dim small">% saturation</span>
            </>}
          </>}
        </div>
        <div className="ag-row">
          <span className="dim small">ramp over</span>
          <input className="narrow" type="number" min={0} step={0.1} value={secs(s.rate_ms)} aria-label="Ramp (s)"
            onChange={(e) => set({ rate_ms: Math.round((Number(e.target.value) || 0) * 1000) })} />
          <span className="dim small">s</span>
          <span className="spread" />
          {n > 1 && <button type="button" className="icon-btn danger" aria-label="Remove step" title="Remove this step" onClick={remove}><Trash2 size={13} strokeWidth={1.8} /></button>}
        </div>
      </div>
    </>
  );
}
