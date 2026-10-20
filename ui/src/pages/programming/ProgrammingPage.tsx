import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { api, type ProgrammingEvent, type ShortItem } from "../../api";
import { CodeRow } from "../../components/DiffView";
import { KindIcon } from "../../components/icons";
import { Grip, MainPane, Panes, SidePane } from "../../components/Panes";
import { Failure, Loading } from "../../components/shell";
import type { Shell } from "../../lib/shell";
import { cx, plural, useLoad } from "../../lib/ui";

/** Every event that has programming, grouped by the device or agent it belongs to. */
export function ProgrammingPage({ shell }: { shell: Shell }) {
  const res = useLoad(() => api.programming(), [shell.rev, shell.director?.id]);
  const [filter, setFilter] = useState("");
  const [focus, setFocus] = useState<number | null>(null);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const by = new Map<number, { device: ShortItem; events: ProgrammingEvent[] }>();
    for (const e of res.data?.events ?? []) {
      const hit = !q || e.device.name.toLowerCase().includes(q) || (e.event_name ?? "").toLowerCase().includes(q)
        || e.lines.some((l) => l.text.toLowerCase().includes(q));
      if (!hit) continue;
      const g = by.get(e.device.id) ?? { device: e.device, events: [] };
      g.events.push(e);
      by.set(e.device.id, g);
    }
    // Agents after devices, like Composer's own programming view; then by name.
    return [...by.values()].sort((a, b) => Number(a.device.kind === "agent") - Number(b.device.kind === "agent") || a.device.name.localeCompare(b.device.name));
  }, [res.data, filter]);

  if (!res.data) return res.error ? <Failure error={res.error} retry={res.reload} /> : <Loading what="Reading programming" />;

  const jump = (id: number) => {
    setFocus(id);
    document.getElementById(`prog-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <Panes id="programming">
      <SidePane id="owners" side="left" title="Devices & agents" defaultSize={250}>
        <div className="search-box">
          <Search size={13} strokeWidth={1.8} />
          <input placeholder="Filter by device, event or line" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="panel-body tw">
          {groups.map((g) => (
            <div key={g.device.id} className={cx("tw-row", focus === g.device.id && "sel")} style={{ paddingLeft: 10 }} onClick={() => jump(g.device.id)}>
              <span className="tw-ic"><KindIcon kind={g.device.kind ?? "device"} driver={g.device.driver} /></span>
              <span className="tw-label">{g.device.name}</span>
              <span className="tw-meta">{g.events.length}</span>
            </div>
          ))}
        </div>
      </SidePane>
      <Grip />
      <MainPane id="code">
        <div className="panel-body prog">
          {!groups.length && <p className="empty pad">{filter ? `Nothing matches “${filter}”.` : "No programming in this project."}</p>}
          {groups.map((g) => (
            <section key={g.device.id} id={`prog-${g.device.id}`} className="prog-group">
              <h3 className="h"><KindIcon kind={g.device.kind ?? "device"} driver={g.device.driver} />{g.device.name}
                <span className="dim small">{plural(g.events.length, "event")}</span></h3>
              {g.events.map((e) => {
                const off = e.lines.filter((l) => !l.enabled).length;
                return (
                  <div key={e.event} className="event">
                    <div className="event-head">
                      <b>{e.event_name ?? `Event #${e.event}`}</b><span className="dim mono small">#{e.event}</span>
                      <span className="spread dim small">{plural(e.lines.length, "line")}{off ? `, ${off} disabled` : ""}</span>
                    </div>
                    <div className="code">{e.lines.map((l) => <CodeRow key={l.id} line={l} />)}</div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </MainPane>
    </Panes>
  );
}
