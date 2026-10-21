/** The tab Composer gives a built-in agent through its own plugin (Scheduler, Advanced
 *  Lighting…), shown first in the inspector. Which agents have one is the backend's call
 *  (`agent_view` answers `view: null` for the rest). */

import type { AgentView } from "../../../api";
import type { Shell } from "../../../lib/shell";
import { AnnouncementsView, LightingView, TemplatesView, WakeSleepView } from "./Others";
import { SchedulerView } from "./Scheduler";
import "../../../styles/agents.css";

export type NativeAgentView = Exclude<AgentView, { view: null }>;

export function AgentPanel({ v, shell, onSelect, reload }: {
  v: NativeAgentView; shell: Shell; onSelect: (id: number) => void; reload: () => void;
}) {
  switch (v.view) {
    case "scheduler": return <SchedulerView agent={v.agent} data={v.data} shell={shell} reload={reload} />;
    case "advanced_lighting": return <LightingView scenes={v.data.scenes} onSelect={onSelect} />;
    case "announcements": return <AnnouncementsView list={v.data.announcements} onSelect={onSelect} />;
    case "wake_sleep": return <WakeSleepView rooms={v.data.rooms} onSelect={onSelect} />;
    case "push_notification": return <TemplatesView kind="push" templates={v.data.templates} onSelect={onSelect} />;
    case "email_notification": return <TemplatesView kind="email" templates={v.data.templates} onSelect={onSelect} />;
  }
}
