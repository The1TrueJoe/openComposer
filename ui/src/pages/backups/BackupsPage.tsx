import { ArrowRight, Archive, GitCompareArrows, HardDriveUpload, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api, errText, type BackupInfo, type BackupResult, type Diff } from "../../api";
import { DiffView } from "../../components/DiffView";
import { Tip, useDialog } from "../../components/Dialogs";
import { Grip, MainPane, Panes, SidePane } from "../../components/Panes";
import { Select, Spinner, Switch } from "../../components/controls";
import { Failure, Loading } from "../../components/shell";
import type { Shell } from "../../lib/shell";
import { bytes, cx, useBackendEvent, useLoad } from "../../lib/ui";

/** The .c4p library — backups you took and the restore points taken before every approved
 *  change — and a semantic compare between any two projects, live or saved. */
export function BackupsPage({ shell }: { shell: Shell }) {
  const lib = useLoad(() => api.listBackups().then((r) => r.backups), []);
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const backups = list ?? lib.data ?? [];
  useBackendEvent("backups", setList);

  const [saving, setSaving] = useState(false);
  // What the last "Back up now" left out, kept on screen: a toast is gone before anyone acts on it.
  const [lastSaved, setLastSaved] = useState<BackupResult | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("live");
  const [runtime, setRuntime] = useState(false);
  const [result, setResult] = useState<{ from: string; to: string; diff: Diff } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const { confirm } = useDialog();

  const sources = useMemo(() => [
    { value: "live", label: `Live — ${shell.director?.name ?? "active Director"}` },
    ...shell.status.config.directors.filter((d) => d.id !== shell.director?.id).map((d) => ({ value: `live:${d.id}`, label: `Live — ${d.name}` })),
    ...backups.map((b) => ({ value: `backup:${b.file}`, label: b.file.replace(/\.c4p$/i, "") })),
  ], [backups, shell.director, shell.status.config.directors]);

  const backupNow = async () => {
    setSaving(true);
    try {
      const b = await api.backupNow();
      setLastSaved(b);
      // The library itself updates from the `backups` event the save emits.
      if (b.note) {
        toast.warning(`Saved ${b.file} — project only`, { description: b.note, duration: 12_000 });
      } else if (b.drivers_missing.length) {
        toast.warning(`Saved ${b.file} with ${b.drivers} driver files`, {
          description: `Couldn't download ${b.drivers_missing.length}: ${b.drivers_missing.join(", ")}`, duration: 12_000,
        });
      } else {
        toast.success(`Saved ${b.file}`, { description: b.drivers ? `With all ${b.drivers} driver files` : undefined });
      }
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const compare = async (f = from, t = to) => {
    if (!f || !t) return;
    setComparing(true);
    setCompareError(null);
    try {
      setResult(await api.compare(f, t, runtime));
    } catch (e) {
      setCompareError(errText(e));
    } finally {
      setComparing(false);
    }
  };

  const load = async (b: BackupInfo) => {
    const ok = await confirm({
      title: `Load ${b.file} into ${shell.director?.name ?? "the Director"}?`,
      description: "This replaces the whole project, like Composer's Load Project. You'll review the diff on an approval card first, and a restore point is saved before anything is written.",
      confirmLabel: "Propose", danger: true,
    });
    if (!ok) return;
    try {
      const o = await api.loadBackup(b.file, `Restore ${b.project} from ${b.created}.`);
      if (o.status === "applied") toast.success("Project loaded");
      else toast.message(o.message);
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <Panes id="backups">
      <SidePane id="library" side="left" title="Library" defaultSize={380} minSize={280} maxSize={620}
                actions={<button className="act small primary" disabled={saving} onClick={backupNow}>
                  {saving ? <Spinner /> : <HardDriveUpload size={13} strokeWidth={1.8} />}Back up now</button>}>
        <div className="panel-body">
          {!lib.data && (lib.error ? <Failure error={lib.error} retry={lib.reload} /> : <Loading />)}
          {lastSaved && (lastSaved.note || lastSaved.drivers_missing.length > 0) && (
            <div className="backup-warn">
              <b>{lastSaved.file}</b>
              {lastSaved.note
                ? <span>Project only, no driver files: {lastSaved.note}</span>
                : <span>{lastSaved.drivers} driver files included; couldn't download {lastSaved.drivers_missing.length}:
                    {" "}<span className="mono">{lastSaved.drivers_missing.join(", ")}</span></span>}
              <button className="act small quiet" onClick={() => setLastSaved(null)}>Dismiss</button>
            </div>
          )}
          {lib.data && !backups.length && <p className="empty pad">No backups yet. “Back up now” saves the live project as a .c4p here.</p>}
          {backups.map((b) => (
            <div key={b.file} className={cx("backup", (from === `backup:${b.file}` || to === `backup:${b.file}`) && "sel")}>
              <div className="backup-top">
                <Archive size={14} strokeWidth={1.8} className="dim" />
                <b title={b.path}>{b.file.replace(/\.c4p$/i, "")}</b>
                {/before change/i.test(b.file) && <span className="tag accent">restore point</span>}
              </div>
              <div className="backup-meta">
                <span>{b.project}</span><span>{b.created}</span><span>{bytes(b.size)}</span>
                {b.drivers > 0 && <span>{b.drivers} drivers</span>}
              </div>
              <div className="backup-meta dim">{b.source}{b.director && ` · ${b.director}`}</div>
              <div className="row">
                <button className="act small" onClick={() => { setFrom(`backup:${b.file}`); setTo("live"); void compare(`backup:${b.file}`, "live"); }}>
                  <GitCompareArrows size={13} strokeWidth={1.8} />Compare with live</button>
                <Tip text={shell.writable ? undefined : "This Director is read-only"}>
                  <span><button className="act small danger" disabled={!shell.writable} onClick={() => load(b)}><Upload size={13} strokeWidth={1.8} />Load into Director…</button></span>
                </Tip>
              </div>
            </div>
          ))}
        </div>
      </SidePane>
      <Grip />
      <MainPane id="compare">
        <div className="panel">
          <div className="filters">
            <Select value={from} onValueChange={setFrom} options={sources} label="From" placeholder="From…" />
            <ArrowRight size={14} strokeWidth={1.8} className="dim" />
            <Select value={to} onValueChange={setTo} options={sources} label="To" placeholder="To…" />
            <label className="inline-switch"><Switch checked={runtime} onCheckedChange={setRuntime} label="Include runtime changes" />Runtime changes</label>
            <button className="act primary" disabled={!from || !to || comparing} onClick={() => compare()}>
              {comparing ? <Spinner /> : <GitCompareArrows size={14} strokeWidth={1.8} />}Compare
            </button>
          </div>
          <div className="panel-body pad">
            {compareError && <Failure error={compareError} retry={() => compare()} />}
            {!result && !compareError && !comparing && (
              <p className="hint flush">Pick two projects — the live one on a Director, or any backup — to see what differs in Composer's terms: rooms, devices, properties, connections, network identities, variables and programming. “Runtime changes” adds things that move on their own (variable values, online status).</p>
            )}
            {comparing && !result && <Loading what="Comparing" />}
            {result && (
              <>
                <div className="compare-head"><b>{result.from}</b><ArrowRight size={14} strokeWidth={1.8} /><b>{result.to}</b></div>
                <DiffView diff={result.diff} empty="These two projects are the same." />
              </>
            )}
          </div>
        </div>
      </MainPane>
    </Panes>
  );
}
