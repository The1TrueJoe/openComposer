/** The tab Composer gives a built-in agent through its own plugin (Scheduler, Advanced
 *  Lighting…), shown first in the inspector. Which agents have one is the backend's call
 *  (`agent_view` answers `view: null` for the rest). */

import type { AgentView } from "../../../api";
import type { Shell } from "../../../lib/shell";
import { AnnouncementsView } from "./Announcements";
import { LightingView } from "./Lighting";
import { EmailView, PushView } from "./Notifications";
import { SchedulerView } from "./Scheduler";
import { WakeSleepView } from "./WakeSleep";
import { Ref } from "./common";
import "../../../styles/agents.css";

export type NativeAgentView = Exclude<AgentView, { view: null }>;

export function AgentPanel({ v, shell, onSelect, reload }: {
  v: NativeAgentView; shell: Shell; onSelect: (id: number) => void; reload: () => void;
}) {
  const p = { agent: v.agent, shell, onSelect, reload };
  switch (v.view) {
    case "scheduler": return <SchedulerView agent={v.agent} data={v.data} shell={shell} reload={reload} />;
    case "advanced_lighting": return <LightingView {...p} data={v.data} />;
    case "announcements": return <AnnouncementsView {...p} data={v.data} />;
    case "wake_sleep": return <WakeSleepView {...p} data={v.data} />;
    case "push_notification": return <PushView {...p} data={v.data} />;
    case "email_notification": return <EmailView agent={v.agent} shell={shell} reload={reload} data={v.data} />;
    case "screen_saver": return (
      <div className="ag">
        <dl className="ag-dl ag-card">
          <dt>Photos from</dt><dd>{v.data.device ? <Ref r={v.data.device} onSelect={onSelect} /> : <span className="dim">no storage device</span>}</dd>
          <dt>Folder</dt><dd className="mono">{v.data.picture_path || <span className="dim">none</span>}</dd>
          <dt>Each photo</dt><dd>{v.data.photo_seconds} s</dd>
        </dl>
        <p className="ag-note dim small">Shown as Composer has it; change it in Composer.</p>
      </div>
    );
  }
}
