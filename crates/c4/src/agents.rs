//! Control4's built-in agents that have no driver web tab (Scheduler, Advanced Lighting,
//! Announcements, …): what openComposer asks each agent for, and what comes back.
//!
//! Every agent is reached the same way: `SendToDevice` to the agent's item with a
//! `<devicecommand>` (`GET_ALL_ENTRIES`, `GET_SCENE_LIST`, `get_announcements`, …), answered
//! synchronously with agent-specific XML. Writes are the same call with another command
//! (`ADD_ENTRY`, …); Director answers those with an empty reply, and the agent reports
//! `entry_added` / `command_failed` to the client afterwards, so a write is checked by
//! reading the project back, as every other op is.
//!
//! Checked against Director 3.3.3 (the Virtual Director and a real EA-1). This module is
//! protocol and parsing only: names are resolved and things are worded for people in the app
//! (`agent_view`).

use roxmltree::Node;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::xml::{child, child_text, escape};

/// The agents openComposer has a native view for, by driver file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Scheduler,
    AdvancedLighting,
    Announcements,
    WakeSleep,
    PushNotification,
    EmailNotification,
    ScreenSaver,
}

impl AgentKind {
    pub fn from_driver(file: &str) -> Option<Self> {
        let f = file.to_ascii_lowercase();
        let stem = f.strip_suffix(".c4i").unwrap_or(&f);
        Some(match stem {
            "control4_agent_scheduler" => Self::Scheduler,
            "control4_agent_adv_lighting" => Self::AdvancedLighting,
            "control4_agent_announcements" => Self::Announcements,
            "control4_agent_wakeup_goodnight" => Self::WakeSleep,
            "control4_agent_notification" => Self::PushNotification,
            "control4_agent_emailnotification" => Self::EmailNotification,
            "control4_agent_screensaver" => Self::ScreenSaver,
            _ => return None,
        })
    }

    /// The name Composer gives the agent's editor.
    pub fn title(self) -> &'static str {
        match self {
            Self::Scheduler => "Scheduler",
            Self::AdvancedLighting => "Advanced Lighting",
            Self::Announcements => "Announcements",
            Self::WakeSleep => "Wake/Sleep",
            Self::PushNotification => "Push Notification",
            Self::EmailNotification => "Email Notification",
            Self::ScreenSaver => "Screen Saver",
        }
    }
}

/// A `<devicecommand>` as the agents take it. `params` are (name, type, value);
/// values are text, so XML payloads (`ENTRY_XML`) travel escaped.
pub fn device_command(command: &str, params: &[(&str, &str, &str)]) -> String {
    let ps: String = params
        .iter()
        .map(|(n, t, v)| format!(r#"<param><name>{}</name><value type="{}"><static>{}</static></value></param>"#, escape(n), escape(t), escape(v)))
        .collect();
    format!(r#"<devicecommand owneridtype="" owneriditem="-1"><command>{}</command><params>{ps}</params></devicecommand>"#, escape(command))
}

/// Agent commands that only read: what may be sent without an approval.
pub fn is_read_command(command: &str) -> bool {
    let c = command.to_ascii_uppercase();
    c.starts_with("GET_") || c.starts_with("IS_")
}

fn text(n: Node<'_, '_>, path: &str) -> String {
    let mut cur = Some(n);
    for part in path.split('/') {
        cur = cur.and_then(|c| child(c, part));
    }
    cur.and_then(|c| c.text()).unwrap_or_default().trim().to_string()
}

fn int(n: Node<'_, '_>, path: &str) -> i64 {
    text(n, path).parse().unwrap_or(0)
}

/// `True`/`true`/`1`, as the agents write booleans.
fn truthy(s: &str) -> bool {
    s.eq_ignore_ascii_case("true") || s == "1"
}

fn flag(n: Node<'_, '_>, path: &str) -> bool {
    truthy(&text(n, path))
}

fn attr(n: Node<'_, '_>, name: &str) -> String {
    n.attribute(name).unwrap_or_default().to_string()
}

fn parse(xml: &str) -> Option<roxmltree::Document<'_>> {
    roxmltree::Document::parse(xml).ok()
}

// ---- Scheduler ---------------------------------------------------------------------------------

/// What a scheduled event's time is measured from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimeBase {
    /// `minutes` after midnight.
    #[default]
    Clock,
    /// `minutes` after sunrise (negative: before).
    Sunrise,
    /// `minutes` after sunset (negative: before).
    Sunset,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Frequency {
    /// Runs once, on the start date.
    #[default]
    Once,
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Frequency {
    fn code(self) -> i64 {
        self as i64
    }
    fn from_code(c: i64) -> Self {
        match c {
            1 => Self::Daily,
            2 => Self::Weekly,
            3 => Self::Monthly,
            4 => Self::Yearly,
            _ => Self::Once,
        }
    }
    fn unit(self) -> &'static str {
        match self {
            Self::Once => "",
            Self::Daily => "day",
            Self::Weekly => "week",
            Self::Monthly => "month",
            Self::Yearly => "year",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Weekday {
    Sunday,
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
}

impl Weekday {
    pub const ALL: [Weekday; 7] =
        [Self::Sunday, Self::Monday, Self::Tuesday, Self::Wednesday, Self::Thursday, Self::Friday, Self::Saturday];
    fn short(self) -> &'static str {
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][self as usize]
    }
    fn name(self) -> &'static str {
        ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][self as usize]
    }
    /// The bit in the scheduler's `daymask` (Sunday = 1 … Saturday = 64).
    fn bit(self) -> i64 {
        1 << (self as i64)
    }
}

/// Composer's "start on the Nth weekday of the month".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Nth {
    First,
    Second,
    Third,
    Fourth,
    Last,
}

impl Nth {
    fn code(self) -> i64 {
        self as i64 + 1
    }
    fn from_code(c: i64) -> Option<Self> {
        Some(match c {
            1 => Self::First,
            2 => Self::Second,
            3 => Self::Third,
            4 => Self::Fourth,
            5 => Self::Last,
            _ => return None,
        })
    }
    fn word(self) -> &'static str {
        ["first", "second", "third", "fourth", "last"][self as usize]
    }
}

/// Start on the `nth` `weekday` of the start date's month instead of on the date itself.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NthWeekday {
    pub nth: Nth,
    /// The weekday; omit with `last` for the last day of the month.
    #[serde(default)]
    pub weekday: Option<Weekday>,
}

/// What can be set on a scheduled event: the fields of Composer's "Edit Entry" dialog.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ScheduleSpec {
    /// The event's name, unique within the Scheduler.
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub time_base: TimeBase,
    /// `clock`: minutes after midnight (0–1439, e.g. 1110 = 6:30 PM). `sunrise`/`sunset`:
    /// offset in minutes, −360…360, negative = before.
    #[serde(default)]
    pub minutes: i32,
    /// Fire up to this many minutes late, at random (0–60).
    #[serde(default)]
    pub randomize_minutes: u32,
    /// First day it can run, `YYYY-MM-DD`.
    pub start_date: String,
    /// Start on the Nth weekday of `start_date`'s month instead (Composer's "Start on").
    #[serde(default)]
    pub start_on: Option<NthWeekday>,
    #[serde(default)]
    pub repeat: Frequency,
    /// Repeat every N days/weeks/months/years (1–100).
    #[serde(default = "one")]
    pub every: u32,
    /// For weekly repeats: the days it runs on.
    #[serde(default)]
    pub days: Vec<Weekday>,
    /// Last day it can run, `YYYY-MM-DD`; omit for no end.
    #[serde(default)]
    pub end_date: Option<String>,
}

fn yes() -> bool {
    true
}
fn one() -> u32 {
    1
}

/// When an entry next runs, as the Scheduler reports it (controller-local time).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NextRun {
    /// `YYYY-MM-DDTHH:MM`
    pub at: String,
    pub timezone: String,
}

/// One scheduled event as the agent stores it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScheduleEntry {
    /// The entry id, which is also its event id in programming.
    pub id: u32,
    #[serde(flatten)]
    pub spec: ScheduleSpec,
    /// Locked entries can't be edited or removed in Composer.
    pub locked: bool,
    /// Hidden entries are kept out of Composer's list (other agents' bookkeeping).
    pub hidden: bool,
    /// The agent that made the entry (e.g. Update Manager), 0 for people.
    pub creator: u32,
    pub category: String,
    /// Only in live reads (`GET_ALL_ENTRIES`), not in the stored project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<NextRun>,
}

fn ymd(s: &str) -> Option<(i64, i64, i64)> {
    let mut it = s.trim().splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (it.next()??, it.next()??, it.next()??);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    ((1900..=2100).contains(&y) && (1..=12).contains(&m) && d >= 1 && d <= days[(m - 1) as usize]).then_some((y, m, d))
}

fn date_str(y: i64, m: i64, d: i64) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

/// `1110` → `6:30 PM`.
pub fn clock_text(minutes: i64) -> String {
    let m = minutes.rem_euclid(1440);
    let (h, mm) = (m / 60, m % 60);
    let (h12, ampm) = match h {
        0 => (12, "AM"),
        1..=11 => (h, "AM"),
        12 => (12, "PM"),
        _ => (h - 12, "PM"),
    };
    format!("{h12}:{mm:02} {ampm}")
}

impl ScheduleSpec {
    /// Composer's "Edit Entry" rules, so a bad entry is refused before anyone approves it.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("a scheduled event needs a name".into());
        }
        match self.time_base {
            TimeBase::Clock if !(0..1440).contains(&self.minutes) => {
                return Err(format!("a clock time is minutes after midnight, 0–1439 (got {})", self.minutes));
            }
            TimeBase::Sunrise | TimeBase::Sunset if self.minutes.abs() > 360 => {
                return Err(format!("the offset from sunrise/sunset must be between −360 and 360 minutes (got {})", self.minutes));
            }
            _ => {}
        }
        if self.randomize_minutes > 60 {
            return Err("the random delay must be between 0 and 60 minutes".into());
        }
        let start = ymd(&self.start_date).ok_or_else(|| format!("start date “{}” isn't a date (YYYY-MM-DD)", self.start_date))?;
        if let Some(s) = &self.start_on {
            if s.weekday.is_none() && s.nth != Nth::Last {
                return Err("start_on needs a weekday (only “last” may omit it, meaning the last day of the month)".into());
            }
        }
        if self.repeat != Frequency::Once {
            if !(1..=100).contains(&self.every) {
                return Err("the repeat rate must be between 1 and 100".into());
            }
            if self.repeat == Frequency::Weekly && self.days.is_empty() {
                return Err("an event repeating weekly needs at least one day".into());
            }
            if let Some(e) = &self.end_date {
                let end = ymd(e).ok_or_else(|| format!("end date “{e}” isn't a date (YYYY-MM-DD)"))?;
                if end < start {
                    return Err("the end date can't be before the start date".into());
                }
            }
        }
        Ok(())
    }

    /// "6:30 PM", "Sunset", "15 min before sunrise".
    pub fn time_text(&self) -> String {
        let sun = |what: &str| match self.minutes {
            0 => format!("{}{}", what[..1].to_uppercase(), &what[1..]),
            m if m < 0 => format!("{} min before {what}", -m),
            m => format!("{m} min after {what}"),
        };
        let base = match self.time_base {
            TimeBase::Clock => clock_text(self.minutes as i64),
            TimeBase::Sunrise => sun("sunrise"),
            TimeBase::Sunset => sun("sunset"),
        };
        if self.randomize_minutes > 0 { format!("{base} (+ up to {} min)", self.randomize_minutes) } else { base }
    }

    /// "Every day", "Every 2 weeks on Mon, Wed", "Once".
    pub fn repeat_text(&self) -> String {
        if self.repeat == Frequency::Once {
            return "Once".into();
        }
        let unit = self.repeat.unit();
        let mut s = if self.every <= 1 { format!("Every {unit}") } else { format!("Every {} {unit}s", self.every) };
        if self.repeat == Frequency::Weekly && !self.days.is_empty() {
            let mut days = self.days.clone();
            days.sort();
            days.dedup();
            let list = if days.len() == 7 {
                "every day".to_string()
            } else if days == [Weekday::Monday, Weekday::Tuesday, Weekday::Wednesday, Weekday::Thursday, Weekday::Friday] {
                "weekdays".to_string()
            } else if days == [Weekday::Sunday, Weekday::Saturday] {
                "weekends".to_string()
            } else {
                days.iter().map(|d| d.short()).collect::<Vec<_>>().join(", ")
            };
            s.push_str(&format!(" on {list}"));
        }
        s
    }

    /// "2024-06-10" or "first Monday of 2024-06".
    pub fn start_text(&self) -> String {
        match &self.start_on {
            None => self.start_date.clone(),
            Some(NthWeekday { nth, weekday }) => {
                let month = self.start_date.get(..7).unwrap_or(&self.start_date);
                match weekday {
                    Some(w) => format!("{} {} of {month}", nth.word(), w.name()),
                    None => format!("last day of {month}"),
                }
            }
        }
    }

    /// The `<entry>` Composer sends in `ADD_ENTRY` / `MODIFY_ENTRY`.
    pub fn to_xml(&self, id: u32, creator: u32, category: &str, locked: bool) -> String {
        let (y, m, d) = ymd(&self.start_date).unwrap_or((2000, 1, 1));
        // Composer stores "Nth weekday" starts as the first of the month plus the rule.
        let (d, period, weekday) = match &self.start_on {
            Some(s) => (1, s.nth.code(), s.weekday.map(|w| w as i64 + 1).unwrap_or(0)),
            None => (d, 0, 0),
        };
        let repeats = self.repeat != Frequency::Once;
        let daymask: i64 = if self.repeat == Frequency::Weekly { self.days.iter().map(|w| w.bit()).fold(0, |a, b| a | b) } else { 0 };
        let tf = |b: bool| if b { "True" } else { "False" };
        let mut x = format!(
            "<entry><eventid>{id}</eventid><description>{}</description><category>{}</category><enabled>{}</enabled>\
             <locked>{}</locked><creatorid>{creator}</creatorid><start><offset>{}</offset><offset_minutes>{}</offset_minutes>\
             <start_date><start_day>{d}</start_day><start_month>{m}</start_month><start_year>{y}</start_year>\
             <start_period>{period}</start_period><start_weekday>{weekday}</start_weekday></start_date>\
             <randomize>{}</randomize></start><repeat><frequency>{}</frequency><rate>{}</rate><daymask>{daymask}</daymask>",
            escape(&self.name),
            escape(category),
            tf(self.enabled),
            tf(locked),
            self.time_base as i64,
            self.minutes,
            self.randomize_minutes,
            if repeats { self.repeat.code() } else { 0 },
            if repeats { self.every.max(1) } else { 0 },
        );
        if let Some((ey, em, ed)) = self.end_date.as_deref().filter(|_| repeats).and_then(ymd) {
            x.push_str(&format!("<end_date><end_day>{ed}</end_day><end_month>{em}</end_month><end_year>{ey}</end_year></end_date>"));
        }
        x.push_str("</repeat></entry>");
        x
    }
}

impl ScheduleEntry {
    /// One `<entry>` from `GET_ALL_ENTRIES` or the agent's stored `entry_data`.
    pub fn from_node(n: Node<'_, '_>) -> Self {
        let date = |prefix: &str, node: &str| {
            let base = format!("{node}/");
            let (y, m, d) = (int(n, &format!("{base}{prefix}_year")), int(n, &format!("{base}{prefix}_month")), int(n, &format!("{base}{prefix}_day")));
            date_str(y, m, d)
        };
        let frequency = Frequency::from_code(int(n, "repeat/frequency"));
        let mask = int(n, "repeat/daymask");
        let start_on = Nth::from_code(int(n, "start/start_date/start_period")).map(|nth| NthWeekday {
            nth,
            weekday: match int(n, "start/start_date/start_weekday") {
                w @ 1..=7 => Some(Weekday::ALL[(w - 1) as usize]),
                _ => None,
            },
        });
        let next = child(n, "next_occurrence").map(|x| NextRun {
            at: format!("{}T{:02}:{:02}", date_str(int(x, "year"), int(x, "month"), int(x, "day")), int(x, "hour"), int(x, "min")),
            timezone: text(x, "timezone"),
        });
        ScheduleEntry {
            id: int(n, "eventid") as u32,
            spec: ScheduleSpec {
                name: text(n, "description"),
                enabled: child(n, "enabled").is_none() || flag(n, "enabled"),
                time_base: match int(n, "start/offset") {
                    1 => TimeBase::Sunrise,
                    2 => TimeBase::Sunset,
                    _ => TimeBase::Clock,
                },
                minutes: int(n, "start/offset_minutes") as i32,
                randomize_minutes: int(n, "start/randomize").max(0) as u32,
                start_date: date("start", "start/start_date"),
                start_on,
                repeat: frequency,
                every: if frequency == Frequency::Once { 1 } else { int(n, "repeat/rate").max(1) as u32 },
                days: if frequency == Frequency::Weekly { Weekday::ALL.into_iter().filter(|w| mask & w.bit() != 0).collect() } else { vec![] },
                end_date: child(n, "repeat").and_then(|r| child(r, "end_date")).map(|_| date("end", "repeat/end_date")),
            },
            locked: flag(n, "locked"),
            hidden: flag(n, "hidden"),
            creator: int(n, "creatorid").max(0) as u32,
            category: text(n, "category"),
            next,
        }
    }
}

/// Every `<entry>` in a `GET_ALL_ENTRIES` reply or a stored `entry_data` value.
pub fn parse_schedule(xml: &str) -> Vec<ScheduleEntry> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants().filter(|n| n.has_tag_name("entry")).map(ScheduleEntry::from_node).collect()
}

/// The Scheduler's entries as stored in the project: the agent item's
/// `<state_values><value name="entry_data">` (escaped XML). Programming refers to them by id.
pub fn schedule_from_item(item: Node<'_, '_>) -> Option<Vec<ScheduleEntry>> {
    let driver = child(item, "itemdata").and_then(|d| child_text(d, "config_data_file"))?;
    if AgentKind::from_driver(driver) != Some(AgentKind::Scheduler) {
        return None;
    }
    let data = child(item, "state_values")?
        .children()
        .find(|v| v.has_tag_name("value") && v.attribute("name") == Some("entry_data"))
        .and_then(|v| v.text())
        .unwrap_or_default();
    Some(parse_schedule(data))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SunTimes {
    /// `HH:MM`, controller-local.
    pub sunrise: String,
    pub sunset: String,
    pub timezone: String,
}

/// A `GET_SUNRISE_SUNSET` reply.
pub fn parse_sun(xml: &str) -> Option<SunTimes> {
    let doc = parse(xml)?;
    let n = doc.descendants().find(|n| n.has_tag_name("sunrise_sunset"))?;
    Some(SunTimes {
        sunrise: format!("{:02}:{:02}", int(n, "sunrise/hour"), int(n, "sunrise/min")),
        sunset: format!("{:02}:{:02}", int(n, "sunset/hour"), int(n, "sunset/min")),
        timezone: text(n, "timezone"),
    })
}

// ---- Stored agent data -------------------------------------------------------------------------

/// What the project download stores for the agents openComposer edits besides the Scheduler:
/// each keeps its whole configuration in its item's `<state>` (escaped XML), so a snapshot
/// has it current, predictions apply to it and verification reads it back like anything else.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentData {
    Lighting { scenes: Vec<LightingScene> },
    Announcements { announcements: Vec<Announcement> },
    WakeSleep { rooms: Vec<WakeSleepScene> },
    Push { templates: Vec<NotificationTemplate>, categories: Vec<(u32, String)>, severities: Vec<(u32, String)> },
    Email { templates: Vec<EmailTemplate> },
    ScreenSaver(ScreenSaver),
}

impl AgentData {
    /// Empty data for an agent whose `<state>` has nothing yet.
    pub fn empty(kind: AgentKind) -> Option<Self> {
        Some(match kind {
            AgentKind::AdvancedLighting => Self::Lighting { scenes: vec![] },
            AgentKind::Announcements => Self::Announcements { announcements: vec![] },
            AgentKind::WakeSleep => Self::WakeSleep { rooms: vec![] },
            AgentKind::PushNotification => Self::Push { templates: vec![], categories: vec![], severities: vec![] },
            AgentKind::EmailNotification => Self::Email { templates: vec![] },
            AgentKind::ScreenSaver => Self::ScreenSaver(ScreenSaver::default()),
            AgentKind::Scheduler => return None,
        })
    }

    /// Parse an agent's stored `<state>` text.
    pub fn parse(kind: AgentKind, state: &str) -> Option<Self> {
        Some(match kind {
            AgentKind::AdvancedLighting => Self::Lighting { scenes: parse_scenes(state) },
            AgentKind::Announcements => Self::Announcements { announcements: parse_announcements(state) },
            AgentKind::WakeSleep => Self::WakeSleep { rooms: parse_wake_sleep(state) },
            AgentKind::PushNotification => Self::Push {
                templates: parse_templates(state),
                categories: parse_named_list(state, "category"),
                severities: parse_named_list(state, "severity"),
            },
            AgentKind::EmailNotification => Self::Email { templates: parse_email_templates(state) },
            AgentKind::ScreenSaver => Self::ScreenSaver(parse_screensaver(state)),
            AgentKind::Scheduler => return None,
        })
    }

    /// The agent's events, for programming.
    pub fn events(&self) -> Vec<(u32, String)> {
        match self {
            Self::Lighting { scenes } => scenes
                .iter()
                .flat_map(|s| {
                    let base = s.id * 5;
                    [
                        (base, format!("When “{}” activates", s.name)),
                        (base + 1, format!("When “{}” deactivates", s.name)),
                        (base + 4, format!("When “{}” is invoked", s.name)),
                    ]
                })
                .collect(),
            Self::Announcements { announcements } => {
                let mut ev = vec![(0, "When any announcement executes".to_string()), (ANNOUNCEMENT_COMPLETE, "When any announcement completes".to_string())];
                for a in announcements {
                    ev.push((a.id, format!("When “{}” executes", a.name)));
                    ev.push((a.id + ANNOUNCEMENT_COMPLETE, format!("When “{}” completes", a.name)));
                }
                ev
            }
            Self::Push { .. } => vec![(1, "When a push notification is sent".into())],
            Self::Email { .. } => vec![(1, "When an email notification is sent".into())],
            Self::WakeSleep { .. } | Self::ScreenSaver(_) => vec![],
        }
    }

    /// The agent's records worded for a diff: what each is, and its settings as people read them.
    pub fn records(&self, p: &crate::Project) -> Vec<Record> {
        match self {
            Self::Lighting { scenes } => scenes.iter().map(|s| s.record(p)).collect(),
            Self::Announcements { announcements } => announcements.iter().map(|a| a.record(p)).collect(),
            Self::WakeSleep { rooms } => rooms.iter().map(|w| w.record(p)).collect(),
            Self::Push { templates, categories, severities } => templates.iter().map(|t| t.record(p, categories, severities)).collect(),
            Self::Email { templates } => templates.iter().map(EmailTemplate::record).collect(),
            Self::ScreenSaver(s) => vec![s.record(p)],
        }
    }
}

/// One thing an agent keeps (a scene, an announcement…), for the semantic diff.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    /// "lighting scene", "announcement"…
    pub what: &'static str,
    pub id: u32,
    pub name: String,
    /// (setting, value), in the order an editor shows them.
    pub fields: Vec<(String, String)>,
}

/// The agent data stored in a project `<item>`, for the agents that have any.
pub fn data_from_item(item: Node<'_, '_>) -> Option<AgentData> {
    let driver = child(item, "itemdata").and_then(|d| child_text(d, "config_data_file"))?;
    let kind = AgentKind::from_driver(driver)?;
    match child_text(item, "state").filter(|s| !s.is_empty()) {
        Some(state) => AgentData::parse(kind, state),
        None => AgentData::empty(kind),
    }
}

/// The reason an agent gave for refusing a command, if it did. Agents answer `<success/>`,
/// `<failure>why</failure>` (Advanced Lighting) or `<fail>why</fail>` (Announcements); an
/// empty `<failure/>` beside a `<success>` (ADD_MEMBERS) is not a refusal.
pub fn reply_failure(xml: &str) -> Option<String> {
    let doc = parse(xml)?;
    let n = doc.descendants().find(|n| (n.has_tag_name("failure") || n.has_tag_name("fail")) && n.has_children())?;
    let why: Vec<&str> = n.descendants().filter(|t| t.is_text()).filter_map(|t| t.text()).map(str::trim).filter(|t| !t.is_empty()).collect();
    (!why.is_empty()).then(|| why.join(", "))
}

fn ms_text(ms: i64) -> String {
    if ms >= 60_000 && ms % 60_000 == 0 {
        format!("{} min", ms / 60_000)
    } else if ms >= 1000 {
        let s = ms as f64 / 1000.0;
        if s.fract() == 0.0 { format!("{s:.0} s") } else { format!("{s:.1} s") }
    } else {
        format!("{ms} ms")
    }
}

/// A device as a diff names it: "Left Lamp (Office)".
fn device_text(p: &crate::Project, id: u32) -> String {
    match p.room_of(id).filter(|r| r.id != id) {
        Some(r) => format!("{} ({})", p.name_of(id), r.name),
        None => p.name_of(id),
    }
}

// ---- Colour ------------------------------------------------------------------------------------
//
// Advanced Lighting stores colours as CIE 1931 xy plus a mode (0 = colour, 1 = a white on
// the Planckian locus). Composer's colour picker works in kelvin or hue/saturation; these
// convert between the two with published formulas, so a value written here reads back the
// same, and one Composer wrote reads back within a few kelvin.

/// A light's colour in a scene step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum LightColor {
    /// A white, by colour temperature in kelvin (1000–20000).
    Temperature { kelvin: u32 },
    /// A colour, by hue (0–359°) and saturation (0–100%).
    Hue { hue: u32, saturation: u32 },
}

pub const KELVIN_MIN: u32 = 1000;
pub const KELVIN_MAX: u32 = 20000;

/// The Planckian locus at `kelvin` (Krystek 1985, in CIE 1960 uv, valid 1000–15000 K and
/// close enough beyond).
pub fn kelvin_to_xy(kelvin: u32) -> (f64, f64) {
    let t = kelvin.clamp(KELVIN_MIN, KELVIN_MAX) as f64;
    let u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) / (1.0 + 8.42420235e-4 * t + 7.08145163e-7 * t * t);
    let v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) / (1.0 - 2.89741816e-5 * t + 1.61456053e-7 * t * t);
    let d = 2.0 * u - 8.0 * v + 4.0;
    (3.0 * u / d, 2.0 * v / d)
}

/// The nearest colour temperature (10 K steps) on the locus, as Composer's picker shows it.
pub fn xy_to_kelvin(x: f64, y: f64) -> u32 {
    (KELVIN_MIN..=KELVIN_MAX)
        .step_by(10)
        .map(|k| {
            let (lx, ly) = kelvin_to_xy(k);
            (k, (x - lx).powi(2) + (y - ly).powi(2))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(k, _)| k)
        .unwrap_or(KELVIN_MIN)
}

/// Linear RGB → XYZ for ITU-R BT.2020 primaries (D65), the gamut Composer's picker uses
/// with OS 3.3.1 and later.
// ponytail: older controllers' Composer used sRGB primaries here; a hue picked on one of
// those would land slightly elsewhere. Only matters if pre-3.3.1 Directors are supported.
const RGB_TO_XYZ: [[f64; 3]; 3] = [[0.636958, 0.1446169, 0.168881], [0.2627002, 0.6779981, 0.0593017], [0.0, 0.0280727, 1.0609851]];

fn invert3(m: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let c = |a: usize, b: usize, c: usize, d: usize| m[a][b] * m[c][d];
    [
        [(c(1, 1, 2, 2) - c(1, 2, 2, 1)) / det, (c(0, 2, 2, 1) - c(0, 1, 2, 2)) / det, (c(0, 1, 1, 2) - c(0, 2, 1, 1)) / det],
        [(c(1, 2, 2, 0) - c(1, 0, 2, 2)) / det, (c(0, 0, 2, 2) - c(0, 2, 2, 0)) / det, (c(0, 2, 1, 0) - c(0, 0, 1, 2)) / det],
        [(c(1, 0, 2, 1) - c(1, 1, 2, 0)) / det, (c(0, 1, 2, 0) - c(0, 0, 2, 1)) / det, (c(0, 0, 1, 1) - c(0, 1, 1, 0)) / det],
    ]
}

fn srgb_decode(c: f64) -> f64 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
fn srgb_encode(c: f64) -> f64 {
    if c <= 0.0031308 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

/// Hue (degrees) and saturation (0–100) at full brightness → xy.
pub fn hs_to_xy(hue: u32, saturation: u32) -> (f64, f64) {
    let (h, s) = ((hue % 360) as f64, saturation.min(100) as f64 / 100.0);
    let x = s * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let (r, g, b) = match (h / 60.0) as u32 {
        0 => (s, x, 0.0),
        1 => (x, s, 0.0),
        2 => (0.0, s, x),
        3 => (0.0, x, s),
        4 => (x, 0.0, s),
        _ => (s, 0.0, x),
    };
    let m = 1.0 - s;
    let lin = [srgb_decode(r + m), srgb_decode(g + m), srgb_decode(b + m)];
    let xyz: Vec<f64> = RGB_TO_XYZ.iter().map(|row| row.iter().zip(lin).map(|(a, b)| a * b).sum()).collect();
    let sum: f64 = xyz.iter().sum();
    if sum == 0.0 { (0.0, 0.0) } else { (xyz[0] / sum, xyz[1] / sum) }
}

/// xy → hue (degrees) and saturation (0–100) at full brightness; colours outside the gamut
/// come back at its edge.
pub fn xy_to_hs(x: f64, y: f64) -> (u32, u32) {
    if y <= 0.0 {
        return (0, 0);
    }
    let xyz = [x / y, 1.0, (1.0 - x - y) / y];
    let inv = invert3(RGB_TO_XYZ);
    let lin: Vec<f64> = inv.iter().map(|row| row.iter().zip(xyz).map(|(a, b)| a * b).sum::<f64>().max(0.0)).collect();
    let max = lin.iter().cloned().fold(0.0, f64::max);
    if max == 0.0 {
        return (0, 0);
    }
    let [r, g, b] = [srgb_encode(lin[0] / max), srgb_encode(lin[1] / max), srgb_encode(lin[2] / max)];
    let (hi, lo) = (r.max(g).max(b), r.min(g).min(b));
    let d = hi - lo;
    let s = if hi == 0.0 { 0.0 } else { d / hi * 100.0 };
    let h = if d == 0.0 {
        0.0
    } else if hi == r {
        (60.0 * ((g - b) / d) + 360.0) % 360.0
    } else if hi == g {
        60.0 * ((b - r) / d) + 120.0
    } else {
        60.0 * ((r - g) / d) + 240.0
    };
    let s = s.round() as u32;
    (if s == 0 { 0 } else { (h.round() as u32) % 360 }, s)
}

impl LightColor {
    /// Read from a stored element: xy plus `colorMode` (1 = white).
    pub fn from_xy(x: f64, y: f64, mode: i64) -> Self {
        if mode == 1 {
            Self::Temperature { kelvin: xy_to_kelvin(x, y) }
        } else {
            let (hue, saturation) = xy_to_hs(x, y);
            Self::Hue { hue, saturation }
        }
    }

    /// (x, y, colorMode) to store.
    pub fn to_xy(self) -> (f64, f64, i64) {
        match self {
            Self::Temperature { kelvin } => {
                let (x, y) = kelvin_to_xy(kelvin);
                (x, y, 1)
            }
            Self::Hue { hue, saturation } => {
                let (x, y) = hs_to_xy(hue, saturation);
                (x, y, 0)
            }
        }
    }

    pub fn validate(self) -> Result<(), String> {
        match self {
            Self::Temperature { kelvin } if !(KELVIN_MIN..=KELVIN_MAX).contains(&kelvin) => {
                Err(format!("a colour temperature is {KELVIN_MIN}–{KELVIN_MAX} K (got {kelvin})"))
            }
            Self::Hue { hue, saturation } if hue >= 360 || saturation > 100 => {
                Err(format!("hue is 0–359° and saturation 0–100% (got {hue}°, {saturation}%)"))
            }
            _ => Ok(()),
        }
    }

    pub fn text(self) -> String {
        match self {
            Self::Temperature { kelvin } => format!("{kelvin} K"),
            Self::Hue { hue, saturation } => format!("hue {hue}°, saturation {saturation}%"),
        }
    }
}

/// Six decimals, as the agent stores coordinates.
pub fn coord(v: f64) -> String {
    format!("{v:.6}")
}

// ---- Advanced Lighting -------------------------------------------------------------------------

/// The lighting proxies Composer offers for Advanced Lighting scenes.
pub const SCENE_LIGHT_DRIVERS: [&str; 5] = ["light_v2.c4i", "fan.c4i", "light.c4i", "outlet_light.c4i", "blindV2.c4i"];

/// "No scene" in toggle ids and the like.
pub const NO_SCENE: u32 = 65535;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LightingSceneInfo {
    pub id: u32,
    pub name: String,
    pub active: bool,
    pub ramp_capable: bool,
}

/// A `GET_SCENE_LIST` reply.
pub fn parse_scene_list(xml: &str) -> Vec<LightingSceneInfo> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants()
        .filter(|n| n.has_tag_name("scene_info"))
        .map(|n| LightingSceneInfo {
            id: int(n, "scene_id") as u32,
            name: text(n, "name"),
            active: flag(n, "is_active"),
            ramp_capable: flag(n, "ramp_capable"),
        })
        .collect()
}

/// One step of a light in a scene (Composer's "element"): after `delay_ms`, go to `level`
/// and/or `color`, ramping over `rate_ms`. Composer's editor ramps the colour at the level's
/// rate and the agent holds it there, so there is one rate.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LightStep {
    /// Wait this long (ms) after the previous step before starting this one.
    #[serde(default)]
    pub delay_ms: u32,
    /// Brightness 0–100 (0 = off); omit to leave the level alone in this step.
    #[serde(default)]
    pub level: Option<u32>,
    /// How long (ms) the level and colour take to get there.
    #[serde(default = "default_rate")]
    pub rate_ms: u32,
    /// The colour to go to; omit to leave the colour alone.
    #[serde(default)]
    pub color: Option<LightColor>,
}

fn default_rate() -> u32 {
    1000
}

/// One hour: longer ramps and delays than this are mistakes rather than intent.
pub const MAX_STEP_MS: u32 = 3_600_000;

impl LightStep {
    pub fn validate(&self) -> Result<(), String> {
        if self.level.is_some_and(|l| l > 100) {
            return Err(format!("a level is 0–100% (got {})", self.level.unwrap_or_default()));
        }
        if self.level.is_none() && self.color.is_none() {
            return Err("a step needs a level, a colour or both".into());
        }
        for (what, v) in [("delay", self.delay_ms), ("ramp", self.rate_ms)] {
            if v > MAX_STEP_MS {
                return Err(format!("the {what} is at most one hour ({MAX_STEP_MS} ms; got {v})"));
            }
        }
        if let Some(c) = self.color {
            c.validate()?;
        }
        Ok(())
    }

    /// "after 1 s: 40% over 3 s, 3200 K"
    pub fn text(&self) -> String {
        let mut parts = Vec::new();
        if let Some(l) = self.level {
            parts.push(if l == 0 { "off".to_string() } else { format!("{l}%") });
        }
        if let Some(c) = self.color {
            parts.push(c.text());
        }
        let body = format!("{} over {}", parts.join(", "), ms_text(self.rate_ms as i64));
        if self.delay_ms > 0 { format!("after {}: {body}", ms_text(self.delay_ms as i64)) } else { body }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LightingMember {
    /// The light (a lighting proxy).
    pub device: u32,
    pub steps: Vec<LightStep>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LightingScene {
    pub id: u32,
    pub name: String,
    /// The scene's "(Toggle)" companion, if it has one.
    pub toggle_id: Option<u32>,
    /// Runtime state, only meaningful in live reads.
    pub active: bool,
    pub members: Vec<LightingMember>,
}

impl LightingScene {
    fn record(&self, p: &crate::Project) -> Record {
        let mut fields: Vec<(String, String)> = self
            .members
            .iter()
            .map(|m| (device_text(p, m.device), m.steps.iter().map(LightStep::text).collect::<Vec<_>>().join(" → ")))
            .collect();
        if let Some(t) = self.toggle_id {
            fields.push(("toggle scene".into(), format!("#{t}")));
        }
        Record { what: "lighting scene", id: self.id, name: self.name.clone(), fields }
    }
}

fn scene_from_node(s: Node<'_, '_>) -> LightingScene {
    let members = s
        .descendants()
        .filter(|n| n.has_tag_name("AdvSceneMember"))
        .map(|m| LightingMember {
            device: int(m, "device_id") as u32,
            steps: m
                .descendants()
                .filter(|e| e.has_tag_name("element"))
                .map(|e| {
                    let xy = |t: &str| text(e, t).parse::<f64>().unwrap_or(0.0);
                    LightStep {
                        delay_ms: int(e, "delay").max(0) as u32,
                        level: flag(e, "levelEnabled").then(|| int(e, "level").clamp(0, 100) as u32),
                        rate_ms: int(e, "levelRate").max(0) as u32,
                        color: flag(e, "colorEnabled").then(|| LightColor::from_xy(xy("colorX"), xy("colorY"), int(e, "colorMode"))),
                    }
                })
                .collect(),
        })
        .collect();
    let toggle = int(s, "toggle_id");
    LightingScene {
        id: int(s, "scene_id") as u32,
        name: text(s, "name"),
        // 65535 is "none"; a toggle scene names itself or none.
        toggle_id: (child(s, "toggle_id").is_some() && toggle >= 0 && toggle != NO_SCENE as i64 && toggle != int(s, "scene_id"))
            .then_some(toggle as u32),
        active: flag(s, "is_active"),
        members,
    }
}

/// A `GET_SCENE` reply (`<AdvScene>`).
pub fn parse_scene(xml: &str) -> Option<LightingScene> {
    let doc = parse(xml)?;
    doc.descendants().find(|n| n.has_tag_name("AdvScene")).map(scene_from_node)
}

/// Every `<AdvScene>`: the agent's stored `<State><all_scenes>`.
pub fn parse_scenes(xml: &str) -> Vec<LightingScene> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants().filter(|n| n.has_tag_name("AdvScene")).map(scene_from_node).collect()
}

// ---- Announcements -----------------------------------------------------------------------------

/// Announcement event ids: N when announcement N executes, this plus N when it completes.
pub const ANNOUNCEMENT_COMPLETE: u32 = 50000;

/// How long Composer lets an announcement stay on screens, in seconds.
pub const DISPLAY_SECONDS: [u32; 9] = [5, 10, 15, 20, 25, 30, 60, 300, 600];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnnouncementTarget {
    pub id: u32,
    pub room: Option<u32>,
    /// −1 = the room's current volume.
    pub volume: Option<i64>,
    pub onscreen: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Announcement {
    pub id: u32,
    pub name: String,
    /// The sound played (a file on the controller, or a URL), with any credentials masked.
    pub audio: Option<String>,
    /// Text shown on screens.
    pub text: Option<String>,
    /// The image or camera shown on screens, with any credentials in it masked.
    pub image: Option<String>,
    /// How long it stays on screens, ms.
    pub display_ms: i64,
    /// Whether screens show an OK button to dismiss it.
    pub ok_button: bool,
    pub rooms: Vec<AnnouncementTarget>,
    pub navigators: Vec<AnnouncementTarget>,
    pub touchscreens: Vec<AnnouncementTarget>,
    /// The `<announcement>` exactly as stored, unmasked: changes keep what they don't touch
    /// (camera logins, delays, variable displays) from here. Never serialized.
    #[serde(skip)]
    pub raw: String,
}

/// `user:pass@` and `password=`-style query values replaced with `••••`: announcement
/// images are often camera URLs with the camera's login in them.
pub fn mask_url_credentials(url: &str) -> String {
    let mut out = url.to_string();
    if let Some(scheme) = out.find("://") {
        let rest = scheme + 3;
        let end = out[rest..].find(['/', '?', '#']).map(|e| rest + e).unwrap_or(out.len());
        if let Some(at) = out[rest..end].rfind('@') {
            out.replace_range(rest..rest + at, MASK);
        }
    }
    let lower = out.to_ascii_lowercase();
    let mut masked = String::with_capacity(out.len());
    let mut i = 0;
    while i < out.len() {
        let hit = ["password=", "pwd=", "pass=", "passwd=", "token=", "key="]
            .iter()
            .find(|k| lower[i..].starts_with(*k) && (i == 0 || matches!(out.as_bytes()[i - 1], b'?' | b'&' | b';')));
        if let Some(k) = hit {
            masked.push_str(&out[i..i + k.len()]);
            i += k.len();
            let end = out[i..].find(['&', '#', ';']).map(|e| i + e).unwrap_or(out.len());
            if end > i {
                masked.push_str(MASK);
            }
            i = end;
        } else {
            let ch = out[i..].chars().next().unwrap();
            masked.push(ch);
            i += ch.len_utf8();
        }
    }
    masked
}

/// What masked credentials are replaced with. A changed URL still containing it means
/// "keep the hidden parts of the current one".
pub const MASK: &str = "••••";

fn announcement_from_node(a: Node<'_, '_>, src: &str) -> Announcement {
    let targets = |list: &str, one: &str| -> Vec<AnnouncementTarget> {
        child(a, list)
            .map(|l| {
                l.children()
                    .filter(|c| c.has_tag_name(one))
                    .map(|c| AnnouncementTarget {
                        id: attr(c, "id").parse().unwrap_or(0),
                        room: c.attribute("room_id").and_then(|r| r.parse().ok()),
                        volume: c.attribute("volume").and_then(|v| v.parse().ok()),
                        onscreen: c.attribute("onscreen").map(truthy),
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let audio = child(a, "audio").map(|x| attr(x, "file")).filter(|s| !s.is_empty());
    let video = child(a, "video");
    Announcement {
        id: attr(a, "id").parse().unwrap_or(0),
        name: attr(a, "name"),
        audio: audio.map(|s| mask_url_credentials(&s)),
        text: video.map(|v| attr(v, "text")).filter(|s| !s.is_empty()),
        image: video.map(|v| attr(v, "file")).filter(|s| !s.is_empty()).map(|s| mask_url_credentials(&s)),
        display_ms: video.and_then(|v| v.attribute("timeout")).and_then(|t| t.parse().ok()).unwrap_or(30000),
        ok_button: video.and_then(|v| v.attribute("OKButton")).is_none_or(truthy),
        rooms: targets("rooms", "room"),
        navigators: targets("navigators", "navigator"),
        touchscreens: targets("touchscreens", "touchscreen"),
        raw: src[a.range()].to_string(),
    }
}

/// A `get_announcements` reply, or the agent's stored `<announcements>`.
pub fn parse_announcements(xml: &str) -> Vec<Announcement> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants()
        .filter(|n| n.has_tag_name("announcement") && n.attribute("id").is_some())
        .map(|a| announcement_from_node(a, xml))
        .collect()
}

impl Announcement {
    fn record(&self, p: &crate::Project) -> Record {
        let vol = |v: Option<i64>| match v {
            Some(v) if v >= 0 => format!(" at {v}%"),
            _ => String::new(),
        };
        // The agent keeps these in its own order (by id); the order means nothing.
        let list = |mut v: Vec<String>| {
            v.sort();
            if v.is_empty() { "none".to_string() } else { v.join(", ") }
        };
        let fields = vec![
            ("sound".to_string(), self.audio.clone().unwrap_or_else(|| "none".into())),
            ("text".to_string(), self.text.clone().unwrap_or_else(|| "none".into())),
            ("image".to_string(), self.image.clone().unwrap_or_else(|| "none".into())),
            ("on screen for".to_string(), format!("{}{}", ms_text(self.display_ms), if self.ok_button { ", with OK button" } else { "" })),
            ("plays in".to_string(), list(self.rooms.iter().map(|r| format!("{}{}", p.name_of(r.id), vol(r.volume))).collect())),
            ("shows on".to_string(), list(self.navigators.iter().map(|n| device_text(p, n.id)).collect())),
            ("touchscreen sound".to_string(), list(self.touchscreens.iter().map(|t| format!("{}{}", device_text(p, t.id), vol(t.volume))).collect())),
        ];
        Record { what: "announcement", id: self.id, name: self.name.clone(), fields }
    }
}

/// A room or touchscreen an announcement plays on, and how loud.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AnnouncementVolume {
    /// The room (for `rooms`) or touchscreen (for `touchscreen_audio`).
    pub id: u32,
    /// 0–100; omit to play at the current volume.
    #[serde(default)]
    pub volume: Option<u32>,
}

/// What can be set on an announcement (Composer's Announcements editor).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AnnouncementSpec {
    /// Unique among the announcements.
    pub name: String,
    /// The sound: a file on the controller (e.g. `bell.mp3`) or an http(s) URL; omit for none.
    #[serde(default)]
    pub audio: Option<String>,
    /// Text shown on screens.
    #[serde(default)]
    pub text: String,
    /// An image or camera snapshot URL shown on screens; omit for none. One that still
    /// contains `••••` (as views show logins) keeps the current image's hidden parts.
    #[serde(default)]
    pub image: Option<String>,
    /// Seconds it stays on screens: 5, 10, 15, 20, 25, 30, 60, 300 or 600.
    #[serde(default = "thirty")]
    pub display_seconds: u32,
    /// Show an OK button to dismiss it.
    #[serde(default = "yes")]
    pub ok_button: bool,
    /// Rooms whose speakers play the sound.
    #[serde(default)]
    pub rooms: Vec<AnnouncementVolume>,
    /// Navigators that show it: controllers' on-screen navigators and touchscreens (their proxies).
    #[serde(default)]
    pub screens: Vec<u32>,
    /// Touchscreens that play the sound through their own speaker.
    #[serde(default)]
    pub touchscreen_audio: Vec<AnnouncementVolume>,
}

fn thirty() -> u32 {
    30
}

impl AnnouncementSpec {
    /// The spec an existing announcement has, as an editor starts from it.
    pub fn of(a: &Announcement) -> Self {
        let vol = |v: Option<i64>| v.filter(|v| *v >= 0).map(|v| v as u32);
        Self {
            name: a.name.clone(),
            audio: a.audio.clone(),
            text: a.text.clone().unwrap_or_default(),
            image: a.image.clone(),
            display_seconds: (a.display_ms / 1000).max(0) as u32,
            ok_button: a.ok_button,
            rooms: a.rooms.iter().map(|r| AnnouncementVolume { id: r.id, volume: vol(r.volume) }).collect(),
            screens: a.navigators.iter().map(|n| n.id).collect(),
            touchscreen_audio: a.touchscreens.iter().map(|t| AnnouncementVolume { id: t.id, volume: vol(t.volume) }).collect(),
        }
    }

    /// The `<announcement>` Composer sends in `add_announcement` / `modify_announcement`.
    /// Settings this spec doesn't cover (delays, variable
    /// displays) and masked credentials are kept from `current`'s stored XML; `room_of` and
    /// `onscreen` describe the screens as Composer would.
    pub fn to_xml(&self, id: u32, current: Option<&Announcement>, room_of: impl Fn(u32) -> u32, onscreen: impl Fn(u32) -> bool) -> String {
        let doc = current.and_then(|c| roxmltree::Document::parse(&c.raw).ok());
        let root = doc.as_ref().map(|d| d.root_element());
        let keep = |tag: Option<&str>, a: &str, default: &str| -> String {
            let n = match tag {
                None => root,
                Some(t) => root.and_then(|r| child(r, t)),
            };
            n.and_then(|n| n.attribute(a)).unwrap_or(default).to_string()
        };
        // A value still showing the mask keeps the stored one.
        let unmask = |v: &Option<String>, tag: &str| -> String {
            match v {
                Some(v) if v.contains(MASK) => keep(Some(tag), "file", ""),
                Some(v) => v.clone(),
                None => String::new(),
            }
        };
        let audio = unmask(&self.audio, "audio");
        let tf = |b: bool| if b { "True" } else { "False" };
        let e = |s: &str| escape(s);
        let vol = |v: Option<u32>| v.map(|v| v.to_string()).unwrap_or_else(|| "-1".into());
        let rooms: String = self.rooms.iter().map(|r| format!(r#"<room id="{}" volume="{}" />"#, r.id, vol(r.volume))).collect();
        let navs: String = self
            .screens
            .iter()
            .map(|n| {
                // A navigator kept from before keeps what Composer decided about it.
                let was = current.and_then(|c| c.navigators.iter().find(|x| x.id == *n)).and_then(|x| x.onscreen);
                format!(r#"<navigator id="{n}" room_id="{}" onscreen="{}" />"#, room_of(*n), tf(was.unwrap_or_else(|| onscreen(*n))))
            })
            .collect();
        let touch: String = self
            .touchscreen_audio
            .iter()
            .map(|t| format!(r#"<touchscreen id="{}" room_id="{}" volume="{}" />"#, t.id, room_of(t.id), vol(t.volume)))
            .collect();
        format!(
            r#"<announcement id="{id}" name="{}" dynamic="{}" advanced="{}"><video file="{}" text="{}" delay="{}" timeout="{}" displayID="{}" variableID="{}" variableName="{}" OKButton="{}" /><audio isurl="{}" file="{}" delay="{}" delayStop="{}" /><rooms>{rooms}</rooms><navigators>{navs}</navigators><touchscreens>{touch}</touchscreens></announcement>"#,
            e(&self.name),
            e(&keep(None, "dynamic", "False")),
            e(&keep(None, "advanced", "True")),
            e(&unmask(&self.image, "video")),
            e(&self.text),
            e(&keep(Some("video"), "delay", "0")),
            self.display_seconds * 1000,
            e(&keep(Some("video"), "displayID", "0")),
            e(&keep(Some("video"), "variableID", "0")),
            e(&keep(Some("video"), "variableName", "")),
            tf(self.ok_button),
            tf(audio.starts_with("http://") || audio.starts_with("https://")),
            e(&audio),
            e(&keep(Some("audio"), "delay", "500")),
            e(&keep(Some("audio"), "delayStop", "0")),
        )
    }
}

// ---- Wake/Sleep --------------------------------------------------------------------------------

/// A room's Wake/Sleep defaults: what its wake-ups and goodnights start from when someone
/// sets one on a touchscreen (Composer's Wake/Sleep editor).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WakeSleepSpec {
    /// Default wake-up time, `HH:MM` (24-hour).
    pub wake_time: String,
    /// The days a wake-up repeats on by default; all seven (or none given) = every day.
    #[serde(default)]
    pub wake_days: Vec<Weekday>,
    /// Minutes the goodnight fade takes by default.
    pub sleep_minutes: u32,
    pub lights: WakeLights,
    pub media: WakeMedia,
    pub blinds: WakeBlinds,
    pub temperature: WakeTemperature,
}

/// `visible`: offered on touchscreens; `enabled`: on by default when someone sets a wake-up.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WakeLights {
    pub visible: bool,
    pub enabled: bool,
    /// One light proxy, or 0 for all the room's lights.
    #[serde(default)]
    pub light: u32,
    /// Minutes the lights take to come up.
    pub ramp_minutes: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WakeMedia {
    pub visible: bool,
    pub enabled: bool,
    /// The source device, or 0 for the room's TV.
    #[serde(default)]
    pub source: u32,
    /// The source's kind as the agent lists it (`watch`, `listen`), or empty for none.
    #[serde(default)]
    pub kind: String,
    /// A channel/station/playlist id from the source, 0 for none.
    #[serde(default)]
    pub item: u32,
    /// Offer only the TV's broadcast channels.
    #[serde(default)]
    pub tv_only: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WakeBlinds {
    pub visible: bool,
    pub enabled: bool,
    /// One blind, or 0 for all the room's blinds.
    #[serde(default)]
    pub blind: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WakeTemperature {
    pub visible: bool,
    pub enabled: bool,
    /// Thermostat mode (`Heat`, `Cool`, … as the room's thermostat names them).
    #[serde(default)]
    pub mode: String,
    /// Setpoint in °F (the agent stores Fahrenheit whatever the display scale).
    pub setpoint_f: i32,
}

impl Default for WakeSleepSpec {
    /// What Composer's "Add" gives a room.
    fn default() -> Self {
        Self {
            wake_time: "06:30".into(),
            wake_days: vec![],
            sleep_minutes: 15,
            lights: WakeLights { visible: true, enabled: true, light: 0, ramp_minutes: 1 },
            media: WakeMedia { visible: true, enabled: true, source: 0, kind: String::new(), item: 0, tv_only: false },
            blinds: WakeBlinds { visible: true, enabled: true, blind: 0 },
            // Only hospitality systems show temperature.
            temperature: WakeTemperature { visible: false, enabled: true, mode: "Cool".into(), setpoint_f: 72 },
        }
    }
}

fn hhmm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some((h, m))
}

impl WakeSleepSpec {
    pub fn validate(&self) -> Result<(), String> {
        hhmm(&self.wake_time).ok_or_else(|| format!("the wake-up time is HH:MM, 00:00–23:59 (got “{}”)", self.wake_time))?;
        if self.sleep_minutes > 240 {
            return Err(format!("the goodnight fade is at most 240 minutes (got {})", self.sleep_minutes));
        }
        if self.lights.ramp_minutes > 240 {
            return Err(format!("the lights' ramp is at most 240 minutes (got {})", self.lights.ramp_minutes));
        }
        if !(40..=99).contains(&self.temperature.setpoint_f) {
            return Err(format!("the setpoint is in °F, 40–99 (got {})", self.temperature.setpoint_f));
        }
        Ok(())
    }

    fn days_text(&self) -> String {
        let mut d = self.wake_days.clone();
        d.sort();
        d.dedup();
        if d.is_empty() || d.len() == 7 { "all".into() } else { d.iter().map(|w| w.short().to_ascii_lowercase()).collect::<Vec<_>>().join(",") }
    }

    /// The `<scene>` Composer sends in `ADD_`/`MODIFY_WAKEUPGOODNIGHTSCENE`.
    pub fn to_xml(&self, id: u32, room: u32, with_days: bool) -> String {
        let (h, m) = hhmm(&self.wake_time).unwrap_or((6, 30));
        let b = |v: bool| if v { "1" } else { "0" };
        let days = if with_days { format!(r#" days_default="{}""#, self.days_text()) } else { String::new() };
        let (l, md, bl, t) = (&self.lights, &self.media, &self.blinds, &self.temperature);
        format!(
            r#"<scene id="{id}" roomid="{room}"><wakeuptime_default hour="{h}" min="{m}"{days} /><goodnighttime_default min="{}" /><lights visible="{}" enabled_default="{}" lightid_default="{}" ramprate_default="{}" /><media visible="{}" enabled_default="{}" mediaid_default="{}" sourceid_default="{}" tvonly="{}" type_default="{}" /><blinds visible="{}" enabled_default="{}" blindid_default="{}" /><temp visible="{}" enabled_default="{}" mode_default="{}" setpoint_default="{}" /></scene>"#,
            self.sleep_minutes,
            b(l.visible), b(l.enabled), l.light, l.ramp_minutes,
            b(md.visible), b(md.enabled), md.item, md.source, if md.tv_only { "True" } else { "False" }, escape(&md.kind),
            b(bl.visible), b(bl.enabled), bl.blind,
            b(t.visible), b(t.enabled), escape(&t.mode), t.setpoint_f,
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WakeSleepScene {
    pub id: u32,
    pub room: u32,
    pub settings: WakeSleepSpec,
}

impl WakeSleepScene {
    fn record(&self, p: &crate::Project) -> Record {
        let s = &self.settings;
        let part = |visible: bool, enabled: bool, what: String| {
            if !visible { "not offered".to_string() } else { format!("{what}{}", if enabled { ", on by default" } else { ", off by default" }) }
        };
        let all = |id: u32, what: &str| if id == 0 { format!("all {what}") } else { device_text(p, id) };
        let media = if s.media.source == 0 { "TV".to_string() } else { device_text(p, s.media.source) };
        let media = if s.media.item != 0 { format!("{media}, item #{}", s.media.item) } else { media };
        let days = s.days_text();
        let fields = vec![
            ("wake-up".to_string(), format!("{} {}", s.wake_time, if days == "all" { "every day".to_string() } else { days })),
            ("goodnight fade".to_string(), format!("{} min", s.sleep_minutes)),
            ("lights".to_string(), part(s.lights.visible, s.lights.enabled, format!("{} over {} min", all(s.lights.light, "lights"), s.lights.ramp_minutes))),
            ("media".to_string(), part(s.media.visible, s.media.enabled, media)),
            ("blinds".to_string(), part(s.blinds.visible, s.blinds.enabled, all(s.blinds.blind, "blinds"))),
            ("temperature".to_string(), part(s.temperature.visible, s.temperature.enabled, format!("{} {}°F", s.temperature.mode, s.temperature.setpoint_f).trim().to_string())),
        ];
        Record { what: "Wake/Sleep room", id: self.id, name: p.name_of(self.room), fields }
    }
}

/// A `GET_WAKEUPGOODNIGHTSCENE_LIST` reply, or the agent's stored state.
pub fn parse_wake_sleep(xml: &str) -> Vec<WakeSleepScene> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants()
        .filter(|n| n.has_tag_name("scene") && n.attribute("roomid").is_some())
        .map(|s| {
            let at = |tag: &str, a: &str| child(s, tag).and_then(|n| n.attribute(a)).unwrap_or_default().trim().to_string();
            let num = |tag: &str, a: &str| at(tag, a).parse::<i64>().unwrap_or(0);
            let yes = |tag: &str, a: &str| {
                let v = at(tag, a);
                truthy(&v) || v.parse::<i64>().is_ok_and(|n| n != 0)
            };
            let days = at("wakeuptime_default", "days_default");
            let wake_days = if days.is_empty() || days.eq_ignore_ascii_case("all") {
                vec![]
            } else {
                Weekday::ALL.into_iter().filter(|w| days.split(',').any(|d| d.trim().eq_ignore_ascii_case(w.short()))).collect()
            };
            WakeSleepScene {
                id: attr(s, "id").parse().unwrap_or(0),
                room: attr(s, "roomid").parse().unwrap_or(0),
                settings: WakeSleepSpec {
                    wake_time: format!("{:02}:{:02}", num("wakeuptime_default", "hour"), num("wakeuptime_default", "min")),
                    wake_days,
                    sleep_minutes: num("goodnighttime_default", "min").max(0) as u32,
                    lights: WakeLights {
                        visible: yes("lights", "visible"),
                        enabled: yes("lights", "enabled_default"),
                        light: num("lights", "lightid_default").max(0) as u32,
                        ramp_minutes: num("lights", "ramprate_default").max(0) as u32,
                    },
                    media: WakeMedia {
                        visible: yes("media", "visible"),
                        enabled: yes("media", "enabled_default"),
                        source: num("media", "sourceid_default").max(0) as u32,
                        kind: at("media", "type_default"),
                        item: num("media", "mediaid_default").max(0) as u32,
                        // Composer reads a missing tvonly as true.
                        tv_only: child(s, "media").and_then(|m| m.attribute("tvonly")).is_none_or(truthy),
                    },
                    blinds: WakeBlinds {
                        visible: yes("blinds", "visible"),
                        enabled: yes("blinds", "enabled_default"),
                        blind: num("blinds", "blindid_default").max(0) as u32,
                    },
                    temperature: WakeTemperature {
                        visible: yes("temp", "visible"),
                        enabled: yes("temp", "enabled_default"),
                        mode: at("temp", "mode_default"),
                        setpoint_f: num("temp", "setpoint_default") as i32,
                    },
                },
            }
        })
        .collect()
}

/// A media source or item the Wake/Sleep agent offers for a room
/// (`GET_MEDIA_SOURCES` → `<source>`, `GET_MEDIA_ITEMS_FOR_SOURCE` → `<item>`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MediaChoice {
    pub id: u32,
    pub name: String,
    /// `watch`, `listen`…
    pub kind: String,
}

pub fn parse_media_choices(xml: &str, tag: &str) -> Vec<MediaChoice> {
    let Some(doc) = parse(xml) else { return vec![] };
    let kind = attr(doc.root_element(), "type");
    doc.descendants()
        .filter(|n| n.has_tag_name(tag))
        .map(|n| MediaChoice {
            id: attr(n, "id").parse().unwrap_or(0),
            name: attr(n, "name"),
            kind: n.attribute("type").map(String::from).unwrap_or_else(|| kind.clone()),
        })
        .collect()
}

/// `GET_TEMPERATURE_MODES`: the room thermostat's modes.
pub fn parse_temperature_modes(xml: &str) -> Vec<String> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants().filter(|n| n.has_tag_name("mode")).filter_map(|n| n.text()).map(|t| t.trim().to_string()).collect()
}

/// `GET_AGENT_STATUS`: whether a hospitality agent runs Wake/Sleep (then temperature is offered
/// and days aren't).
pub fn parse_hospitality(xml: &str) -> bool {
    parse(xml)
        .and_then(|d| d.descendants().find(|n| n.has_tag_name("hospitality_mode")).and_then(|n| n.attribute("active")).map(|a| truthy(a) || a.parse::<i64>().is_ok_and(|v| v != 0)))
        .unwrap_or(false)
}

// ---- Push / email notification ----------------------------------------------------------------

/// A camera snapshot (or other attachment) a push notification carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Attachment {
    /// The device that provides it (e.g. a camera).
    pub owner: u32,
    /// The attachment's id on that device (GET_ATTACHMENT_PROVIDER_LIST).
    pub id: u32,
}

/// What can be set on a push notification (Composer's Push Notification editor).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PushTemplateSpec {
    pub name: String,
    /// A category id from the agent's list (0 = none).
    #[serde(default)]
    pub category: u32,
    /// A severity id from the agent's list (0 = none).
    #[serde(default)]
    pub severity: u32,
    /// The notification's title.
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub message: String,
    /// Add the time it was sent.
    #[serde(default = "yes")]
    pub timestamp: bool,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NotificationTemplate {
    pub id: u32,
    #[serde(flatten)]
    pub spec: PushTemplateSpec,
}

impl PushTemplateSpec {
    /// The `<template>` Composer sends in `ADD_TEMPLATE` / `MODIFY_TEMPLATE`.
    pub fn to_xml(&self, id: u32) -> String {
        let atts: String = self
            .attachments
            .iter()
            .map(|a| format!("<attachment><owner>{}</owner><id>{}</id></attachment>", a.owner, a.id))
            .collect();
        format!(
            "<template><templateid>{id}</templateid><name>{}</name><category>{}</category><severity>{}</severity><subject>{}</subject><message>{}</message><timestamp>{}</timestamp><attachments>{atts}</attachments></template>",
            escape(&self.name),
            self.category,
            self.severity,
            escape(&self.subject),
            escape(&self.message),
            if self.timestamp { 1 } else { 0 },
        )
    }
}

impl NotificationTemplate {
    fn record(&self, p: &crate::Project, categories: &[(u32, String)], severities: &[(u32, String)]) -> Record {
        let s = &self.spec;
        let named = |l: &[(u32, String)], v: u32| {
            if v == 0 { "none".to_string() } else { l.iter().find(|(i, _)| *i == v).map(|(_, n)| n.clone()).unwrap_or_else(|| format!("#{v}")) }
        };
        let fields = vec![
            ("category".to_string(), named(categories, s.category)),
            ("severity".to_string(), named(severities, s.severity)),
            ("title".to_string(), s.subject.clone()),
            ("message".to_string(), s.message.clone()),
            ("timestamp".to_string(), if s.timestamp { "yes" } else { "no" }.to_string()),
            ("snapshots".to_string(), if s.attachments.is_empty() { "none".into() } else { s.attachments.iter().map(|a| device_text(p, a.owner)).collect::<Vec<_>>().join(", ") }),
        ];
        Record { what: "push notification", id: self.id, name: s.name.clone(), fields }
    }
}

/// A `GET_TEMPLATE_LIST` reply or the push agent's stored `<templates>`.
pub fn parse_templates(xml: &str) -> Vec<NotificationTemplate> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants()
        .filter(|n| n.has_tag_name("template"))
        .map(|t| NotificationTemplate {
            id: int(t, "templateid") as u32,
            spec: PushTemplateSpec {
                name: text(t, "name"),
                category: int(t, "category").max(0) as u32,
                severity: int(t, "severity").max(0) as u32,
                subject: text(t, "subject"),
                message: text(t, "message"),
                timestamp: child(t, "timestamp").is_none() || flag(t, "timestamp"),
                attachments: t
                    .descendants()
                    .filter(|a| a.has_tag_name("attachment"))
                    .map(|a| Attachment { owner: int(a, "owner") as u32, id: int(a, "id") as u32 })
                    .collect(),
            },
        })
        .collect()
}

/// What can be attached to a push notification (`GET_ATTACHMENT_PROVIDER_LIST`):
/// (owner device, attachment id, label such as "Snapshot (URL)").
pub fn parse_attachment_providers(xml: &str) -> Vec<(u32, u32, String)> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants()
        .filter(|n| n.has_tag_name("attachment_provider"))
        .flat_map(|prov| {
            let owner = int(prov, "id") as u32;
            prov.children().filter(|t| t.has_tag_name("attachment_type")).map(move |t| {
                let label = Some(text(t, "custom_description")).filter(|s| !s.is_empty()).unwrap_or_else(|| text(t, "description"));
                (owner, int(t, "id") as u32, label)
            })
        })
        .collect()
}

/// `GET_CATEGORY_LIST` / `GET_SEVERITY_LIST` or the stored lists: id → name.
pub fn parse_named_list(xml: &str, tag: &str) -> Vec<(u32, String)> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants().filter(|n| n.has_tag_name(tag) && child(*n, "id").is_some()).map(|n| (int(n, "id") as u32, text(n, "name"))).collect()
}

/// What can be set on an email notification (Composer's Email Notification editor).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EmailTemplateSpec {
    pub name: String,
    /// Recipients, comma-separated.
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub body: String,
    /// Add the time it was sent.
    #[serde(default = "yes")]
    pub timestamp: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EmailTemplate {
    pub id: u32,
    #[serde(flatten)]
    pub spec: EmailTemplateSpec,
}

impl EmailTemplateSpec {
    /// The `<template>` Composer sends in `ADD_TEMPLATE` / `MODIFY_TEMPLATE`.
    pub fn to_xml(&self, id: u32) -> String {
        format!(
            "<template><templateid>{id}</templateid><name>{}</name><email><timestamp>{}</timestamp><to>{}</to><subject>{}</subject><body>{}</body></email></template>",
            escape(&self.name),
            if self.timestamp { 1 } else { 0 },
            escape(&self.to),
            escape(&self.subject),
            escape(&self.body),
        )
    }
}

impl EmailTemplate {
    fn record(&self) -> Record {
        let s = &self.spec;
        let fields = vec![
            ("to".to_string(), s.to.clone()),
            ("subject".to_string(), s.subject.clone()),
            ("body".to_string(), s.body.clone()),
            ("timestamp".to_string(), if s.timestamp { "yes" } else { "no" }.to_string()),
        ];
        Record { what: "email notification", id: self.id, name: s.name.clone(), fields }
    }
}

/// The email agent's `GET_TEMPLATE_LIST` reply or its stored templates (the same `<template>`s).
pub fn parse_email_templates(xml: &str) -> Vec<EmailTemplate> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants()
        .filter(|n| n.has_tag_name("template"))
        .map(|t| {
            let e = child(t, "email");
            let et = |tag: &str| e.map(|e| text(e, tag)).unwrap_or_default();
            EmailTemplate {
                id: int(t, "templateid") as u32,
                spec: EmailTemplateSpec {
                    name: text(t, "name"),
                    to: et("to"),
                    subject: et("subject"),
                    body: et("body"),
                    timestamp: e.is_none_or(|e| child(e, "timestamp").is_none() || flag(e, "timestamp")),
                },
            }
        })
        .collect()
}

// ---- Screen Saver ------------------------------------------------------------------------------

/// The touchscreens' photo screen saver (Composer's Screen Saver agent); read-only here.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ScreenSaver {
    /// The storage device the photos come from (0 = none).
    pub device: u32,
    /// The folder on it.
    pub picture_path: String,
    /// Seconds each photo shows.
    pub photo_seconds: u32,
}

impl ScreenSaver {
    fn record(&self, p: &crate::Project) -> Record {
        let fields = vec![
            ("photos from".to_string(), if self.device == 0 { "none".into() } else { device_text(p, self.device) }),
            ("folder".to_string(), if self.picture_path.is_empty() { "none".into() } else { self.picture_path.clone() }),
            ("each photo".to_string(), format!("{} s", self.photo_seconds)),
        ];
        Record { what: "screen saver", id: 0, name: "Screen saver".into(), fields }
    }
}

/// The agent's stored `<screensaver>`.
pub fn parse_screensaver(xml: &str) -> ScreenSaver {
    let Some(doc) = parse(xml) else { return ScreenSaver::default() };
    let Some(n) = doc.descendants().find(|n| n.has_tag_name("screensaver")) else { return ScreenSaver::default() };
    ScreenSaver {
        device: int(n, "deviceid").max(0) as u32,
        picture_path: text(n, "picturepath"),
        photo_seconds: int(n, "phototimeoutintervalinseconds").max(0) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRIES: &str = "<entries><entry><eventid>1</eventid><description>Component Auto Update Event</description><category/><enabled>True</enabled><locked>False</locked><creatorid>100116</creatorid><creatorstate/><hidden>False</hidden><user_hidden>False</user_hidden><start><offset>0</offset><offset_minutes>201</offset_minutes><start_date><start_day>10</start_day><start_month>6</start_month><start_year>2024</start_year><start_period>0</start_period><start_weekday>0</start_weekday></start_date><randomize>0</randomize></start><next_occurrence><year>2026</year><month>10</month><day>21</day><hour>3</hour><min>21</min><timezone/></next_occurrence><repeat><frequency>2</frequency><rate>1</rate><daymask>111</daymask></repeat></entry><entry><eventid>6</eventid><description>Sunrise</description><category/><enabled>True</enabled><locked>False</locked><creatorid>0</creatorid><hidden>False</hidden><start><offset>1</offset><offset_minutes>15</offset_minutes><start_date><start_day>16</start_day><start_month>6</start_month><start_year>2024</start_year><start_period>0</start_period><start_weekday>0</start_weekday></start_date><randomize>0</randomize></start><repeat><frequency>1</frequency><rate>1</rate><daymask>0</daymask></repeat></entry></entries>";

    #[test]
    fn reads_scheduler_entries() {
        let e = parse_schedule(ENTRIES);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].spec.time_text(), "3:21 AM");
        // 111 = Sun, Mon, Tue, Wed, Fri, Sat.
        assert_eq!(e[0].spec.days.len(), 6);
        assert_eq!(e[0].creator, 100116);
        assert_eq!(e[0].next.as_ref().unwrap().at, "2026-10-21T03:21");
        assert_eq!(e[1].spec.time_text(), "15 min after sunrise");
        assert_eq!(e[1].spec.repeat_text(), "Every day");
        assert_eq!(e[1].spec.start_date, "2024-06-16");
    }

    #[test]
    fn entry_xml_round_trips() {
        let spec = ScheduleSpec {
            name: "Porch <on>".into(),
            enabled: false,
            time_base: TimeBase::Sunset,
            minutes: -15,
            randomize_minutes: 5,
            start_date: "2026-10-21".into(),
            start_on: None,
            repeat: Frequency::Weekly,
            every: 2,
            days: vec![Weekday::Monday, Weekday::Friday],
            end_date: Some("2027-01-01".into()),
        };
        spec.validate().unwrap();
        let x = spec.to_xml(12, 0, "", false);
        assert!(x.contains("<description>Porch &lt;on&gt;</description>") && x.contains("<daymask>34</daymask>"), "{x}");
        let back = parse_schedule(&x).remove(0);
        assert_eq!(back.id, 12);
        assert_eq!(back.spec, spec);
        assert_eq!(back.spec.repeat_text(), "Every 2 weeks on Mon, Fri");
    }

    #[test]
    fn composer_rules_are_enforced() {
        let mut s = parse_schedule(ENTRIES).remove(1).spec;
        s.minutes = 400;
        assert!(s.validate().is_err());
        s.minutes = 0;
        s.repeat = Frequency::Weekly;
        assert!(s.validate().unwrap_err().contains("at least one day"));
        s.start_date = "2026-02-30".into();
        assert!(s.validate().is_err());
    }

    #[test]
    fn masks_camera_logins() {
        let u = "http://10.0.0.50:80/wps-cgi/jpg/image.cgi?camera=6&username=viewer&password=hunter2";
        assert_eq!(mask_url_credentials(u), "http://10.0.0.50:80/wps-cgi/jpg/image.cgi?camera=6&username=viewer&password=••••");
        assert_eq!(mask_url_credentials("rtsp://admin:pw@cam/stream"), "rtsp://••••@cam/stream");
    }

    #[test]
    fn reads_other_agents() {
        let s = parse_scene("<AdvScene><name>Bedroom On</name><scene_id>2</scene_id><toggle_id>3</toggle_id><is_active>False</is_active><all_members><AdvSceneMember><device_id>1248</device_id><all_elements><element><delay>0</delay><levelEnabled>True</levelEnabled><levelRate>250</levelRate><level>100</level><colorEnabled>True</colorEnabled><colorRate>250</colorRate><colorX>0.423358</colorX><colorY>0.398951</colorY><colorMode>1</colorMode></element></all_elements></AdvSceneMember></all_members></AdvScene>").unwrap();
        // Composer's own 3200 K reads back as 3200 K.
        assert_eq!((s.toggle_id, s.members[0].device, s.members[0].steps[0].color), (Some(3), 1248, Some(LightColor::Temperature { kelvin: 3200 })));
        assert_eq!(s.members[0].steps[0].text(), "100%, 3200 K over 250 ms");
        let w = parse_wake_sleep(r#"<wakeupgoodnightscenes><scene id="1" roomid="71"><wakeuptime_default hour="7" min="30" days_default="all"/><goodnighttime_default min="60"/><lights visible="true" enabled_default="false" lightid_default="0" ramprate_default="1"/><blinds visible="false" enabled_default="false" blindid_default="0"/></scene></wakeupgoodnightscenes>"#);
        assert_eq!((w[0].room, w[0].settings.wake_time.as_str(), w[0].settings.blinds.visible), (71, "07:30", false));
        let t = parse_templates("<templates><template><templateid>2</templateid><name>Gate Open</name><category>2</category><severity>2</severity><subject>Open</subject><message/><timestamp>1</timestamp><attachments><attachment><owner>378</owner><id>1003</id></attachment></attachments></template></templates>");
        assert_eq!((t[0].id, t[0].spec.attachments[0]), (2, Attachment { owner: 378, id: 1003 }));
        assert_eq!(parse_templates(&t[0].spec.to_xml(2))[0], t[0]);
    }

    #[test]
    fn colours_round_trip() {
        for k in [1000, 2700, 3200, 4000, 6500, 15000, 20000] {
            let (x, y) = kelvin_to_xy(k);
            let (x, y) = (coord(x).parse().unwrap(), coord(y).parse().unwrap());
            assert_eq!(xy_to_kelvin(x, y), k);
        }
        for (h, s) in [(0, 100), (30, 80), (120, 100), (200, 45), (300, 10), (0, 0)] {
            let (x, y) = hs_to_xy(h, s);
            let (x, y) = (coord(x).parse().unwrap(), coord(y).parse().unwrap());
            assert_eq!(xy_to_hs(x, y), (h, s), "hue {h} saturation {s}");
        }
        assert!(LightColor::Temperature { kelvin: 500 }.validate().is_err());
    }

    #[test]
    fn agent_refusals_are_read() {
        assert_eq!(reply_failure("<failure>Name in use</failure>").as_deref(), Some("Name in use"));
        assert_eq!(reply_failure("<added_members><success><MEMBER_ID>1</MEMBER_ID></success><failure/></added_members>"), None);
        assert_eq!(reply_failure("<added_members><success/><failure><MEMBER_ID>14</MEMBER_ID></failure></added_members>").as_deref(), Some("14"));
        assert_eq!(reply_failure("<fail>No such announcement</fail>").as_deref(), Some("No such announcement"));
        assert_eq!(reply_failure("<success/>"), None);
    }

    #[test]
    fn announcements_keep_what_they_mask() {
        let x = r#"<announcements><announcement id="2" name="Doorbell" dynamic="false" advanced="true"><audio isurl="false" file="bell.mp3" delay="500" delayStop="0"/><video file="http://10.0.0.5/snap.cgi?user=view&amp;password=secret" text="Someone is at the door" delay="0" timeout="30000" displayID="0" variableID="0" variableName="" OKButton="true"/><rooms><room id="14" volume="-1"/></rooms><navigators><navigator id="31" room_id="95" onscreen="true"/></navigators><touchscreens/></announcement></announcements>"#;
        let a = parse_announcements(x).remove(0);
        assert_eq!(a.image.as_deref(), Some("http://10.0.0.5/snap.cgi?user=view&password=••••"));
        assert!(a.raw.contains("password=secret") && !serde_json::to_string(&a).unwrap().contains("secret"));
        assert_eq!((a.display_ms, a.ok_button, a.rooms[0].id), (30000, true, 14));
    }

    #[test]
    fn wake_sleep_xml_round_trips() {
        let mut s = WakeSleepSpec::default();
        s.wake_days = vec![Weekday::Monday, Weekday::Friday];
        s.media.kind = "watch".into();
        s.validate().unwrap();
        let back = parse_wake_sleep(&s.to_xml(3, 71, true)).remove(0);
        assert_eq!((back.id, back.room, &back.settings), (3, 71, &s));
        assert!(!s.to_xml(0, 71, false).contains("days_default"));
    }
}
