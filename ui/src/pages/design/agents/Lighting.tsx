/** The Advanced Lighting agent's own tab, in place of Composer's scene editor: a table of
 *  scenes; the picked scene's lights in a second table, with what each does step by step; the
 *  picked light's steps in an editor under that. Scenes are made, renamed and removed, and
 *  lights added, set and removed, as approvals (*_lighting_scene, set/remove_scene_light). */

import { createColumnHelper } from "@tanstack/react-table";
import { Lightbulb, Plus, Trash2, Type } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { LightColor, LightStep, LightingData, LightingSceneView, NamedRef, Op } from "../../../api";
import { DataTable } from "../../../components/DataTable";
import { Tip, useDialog } from "../../../components/Dialogs";
import { WithDetail } from "../../../components/Panes";
import type { Shell } from "../../../lib/shell";
import { cx, plural } from "../../../lib/ui";
import { AgentSplit, DetailPane, EditorCard, IconAct, MultiPick, ProgramLink, Ref, RemoveIcon, ms, useWrites } from "./common";

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

type Member = LightingSceneView["members"][number];
const sceneCol = createColumnHelper<LightingSceneView>();
const lightCol = createColumnHelper<Member>();

/** A scene's events are numbered from its id: activates, deactivates, is invoked. */
const SCENE_EVENTS: [number, string][] = [[0, "Activates"], [1, "Deactivates"], [4, "Is invoked"]];

export function LightingView({ agent, data, shell, onSelect, reload }: {
  agent: { id: number; name: string }; data: LightingData; shell: Shell; onSelect: (id: number) => void; reload: () => void;
}) {
  const dialog = useDialog();
  const w = useWrites(shell, reload);
  const [picked, setPicked] = useState<number | null>(null);
  const [light, setLight] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const names = data.scenes.map((s) => s.name.trim().toLowerCase());
  const scene = data.scenes.find((s) => s.id === picked) ?? null;

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
    if (ok && await w.propose([{ op: "remove_lighting_scene", agent: agent.id, scene: s.id }], `Remove the lighting scene “${s.name}”.`)) setPicked(null);
  };

  const columns = useMemo(() => [
    sceneCol.accessor("name", {
      header: "Scene",
      cell: (c) => (
        <span className="row nowrap ellip">
          <span className="ellip">{c.getValue()}</span>
          {c.row.original.active && <span className="tag on">active</span>}
        </span>
      ),
    }),
    sceneCol.accessor((s) => s.members.length, { id: "lights", header: "Lights", meta: { width: 62, align: "right" } }),
    sceneCol.accessor((s) => s.toggle?.name ?? "", {
      id: "toggle", header: "Toggles with", meta: { width: "30%", hideBelow: 520 },
      cell: (c) => (c.getValue() ? <span className="ellip dim">{c.getValue()}</span> : <span className="dim">—</span>),
    }),
    sceneCol.accessor("programmed", { header: "Lines", meta: { width: 58, align: "right" }, cell: (c) => c.getValue() || <span className="dim">—</span> }),
  ], []);

  const pick = (id: number | null) => {
    if (id !== picked) { setLight(null); setAdding(false); }
    setPicked(id);
  };

  return (
    <AgentSplit id="lighting" defaultSize="70%" bar={<>
      <span className="dim small">{plural(data.scenes.length, "scene")}</span>
      <span className="spread" />
      <Tip text={w.why ?? "Add a scene"}>
        <span><button className="act small primary" disabled={!w.can} onClick={create}><Plus size={13} strokeWidth={2} />New scene</button></span>
      </Tip>
    </>} detail={scene && (
      <SceneDetail key={scene.id} agent={agent.id} scene={scene} data={data} w={w} shell={shell} onSelect={onSelect}
        light={light} onLight={setLight} adding={adding} onAdding={setAdding} onRename={() => rename(scene)} onRemove={() => remove(scene)} />
    )}>
      <DataTable data={data.scenes} columns={columns} rowId={(s) => String(s.id)} label="Lighting scenes" sort={[{ id: "name", desc: false }]}
        selected={scene ? String(scene.id) : null} onSelect={(s) => pick(s.id)}
        onActivate={(s) => shell.program({ device: agent.id, event: s.id * 5 })}
        empty={<p className="empty">No Advanced Lighting scenes yet.</p>} />
    </AgentSplit>
  );
}

/** One scene: its lights in a second table, and the picked light's steps under that. */
function SceneDetail({ agent, scene: s, data, w, shell, onSelect, light, onLight, adding, onAdding, onRename, onRemove }: {
  agent: number; scene: LightingSceneView; data: LightingData; w: ReturnType<typeof useWrites>; shell: Shell; onSelect: (id: number) => void;
  light: number | null; onLight: (id: number | null) => void; adding: boolean; onAdding: (on: boolean) => void; onRename: () => void; onRemove: () => void;
}) {
  const member = s.members.find((m) => m.device.id === light) ?? null;
  const columns = useMemo(() => [
    lightCol.accessor((m) => m.device.name, {
      id: "light", header: "Light",
      cell: (c) => <span className="ellip">{c.getValue()}{c.row.original.device.room && c.row.original.device.room !== c.getValue() && <span className="dim"> · {c.row.original.device.room}</span>}</span>,
    }),
    lightCol.accessor((m) => m.steps[0]?.level ?? -1, {
      id: "level", header: "Level", meta: { width: 64, align: "right" },
      cell: (c) => { const v = c.row.original.steps[0]?.level; return v == null ? <span className="dim">—</span> : v === 0 ? "off" : `${v}%`; },
    }),
    lightCol.display({
      id: "color", header: "Colour", meta: { width: 96, hideBelow: 420 },
      cell: (c) => { const col = c.row.original.steps[0]?.color; return col ? <span className="row nowrap"><span className="ag-swatch" style={{ background: colorCss(col) }} /><span className="dim">{"kelvin" in col ? `${col.kelvin} K` : `${col.hue}°`}</span></span> : <span className="dim">—</span>; },
    }),
    lightCol.accessor((m) => m.steps[0]?.rate_ms ?? 0, { id: "ramp", header: "Ramp", meta: { width: 70, align: "right", hideBelow: 360 }, cell: (c) => ms(c.getValue()) }),
    lightCol.accessor((m) => m.steps.length, { id: "steps", header: "Steps", meta: { width: 56, align: "right" } }),
  ], []);

  return (
    <DetailPane fill icon={<Lightbulb size={14} strokeWidth={1.8} />} title={s.name}
      tags={<>
        <span className="dim mono small">#{s.id}</span>
        {s.active && <span className="tag on">active</span>}
        {s.toggle && <span className="tag" title="Its toggle scene">toggles with {s.toggle.name}</span>}
        {!!s.programmed && <span className="tag accent" title="Under its activates, deactivates and is-invoked events">{plural(s.programmed, "programming line")}</span>}
      </>}
      actions={<>
        {SCENE_EVENTS.map(([n, label]) => (
          <ProgramLink key={n} lines={0} label={label} onClick={() => shell.program({ device: agent, event: s.id * 5 + n })} />
        ))}
        <IconAct label="Add lights" why={w.why} disabled={w.busy} onClick={() => onAdding(!adding)}><Plus size={13} strokeWidth={1.8} /></IconAct>
        <IconAct label="Rename" why={w.why} disabled={w.busy} onClick={onRename}><Type size={13} strokeWidth={1.8} /></IconAct>
        <IconAct label="Remove the scene" why={w.why} disabled={w.busy} danger onClick={onRemove}><RemoveIcon /></IconAct>
      </>}>
      {adding && (
        <AddLights scene={s} lights={data.lights} busy={w.busy} onCancel={() => onAdding(false)}
          onAdd={async (ids) => {
            const ops: Op[] = ids.map((id) => ({ op: "set_scene_light", agent, scene: s.id, light: id, steps: [DEFAULT_STEP] }));
            if (await w.propose(ops, `Add ${plural(ids.length, "light")} to the lighting scene “${s.name}”.`)) onAdding(false);
          }} />
      )}
      <WithDetail id="lighting-scene" defaultSize="64%" minSize={120} detail={member && (
        <div className="ag-detail-body">
          {w.why ? (
            <div className="ag-steps-ro">
              <div className="ag-detail-head"><Ref r={member.device} onSelect={onSelect} /></div>
              <div className="ag-pad">{member.steps.map((st, i) => <div key={i}><StepText step={st} /></div>)}</div>
            </div>
          ) : (
            <StepsEditor key={`${s.id}:${member.device.id}`} light={member.device} steps={member.steps} busy={w.busy} onCancel={() => onLight(null)}
              aside={<>
                <Tip text="Show it in the project"><button type="button" className="act small quiet" onClick={() => onSelect(member.device.id)}>Go to light</button></Tip>
                <Tip text="Take it out of the scene">
                  <span><button type="button" className="icon-btn danger" aria-label="Remove from scene" disabled={w.busy}
                    onClick={async () => {
                      if (await w.propose([{ op: "remove_scene_light", agent, scene: s.id, light: member.device.id }],
                        `Take “${member.device.name}” out of the lighting scene “${s.name}”.`)) onLight(null);
                    }}><Trash2 size={13} strokeWidth={1.8} /></button></span>
                </Tip>
              </>}
              onSave={(steps) => w.propose([{ op: "set_scene_light", agent, scene: s.id, light: member.device.id, steps }],
                `Change what “${member.device.name}” does in the lighting scene “${s.name}”.`)} />
          )}
        </div>
      )}>
        <DataTable data={s.members} columns={columns} rowId={(m) => String(m.device.id)} label={`Lights in ${s.name}`} sort={[{ id: "light", desc: false }]}
          selected={member ? String(member.device.id) : null} onSelect={(m) => onLight(m.device.id)} onActivate={(m) => onSelect(m.device.id)}
          empty={<p className="empty">No lights in this scene yet{w.why ? "." : " — add some with +."}</p>} />
      </WithDetail>
    </DetailPane>
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
function StepsEditor({ light, steps: initial, busy, onCancel, onSave, aside }: {
  light: NamedRef; steps: LightStep[]; busy: boolean; onCancel: () => void; onSave: (s: LightStep[]) => void; aside?: React.ReactNode;
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
      onCancel={onCancel} onSave={() => onSave(steps)} aside={aside}>
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
