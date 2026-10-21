//! Control4's built-in agents whose Composer editors are .NET plugins
//! (`control4_agent_*.c4a.dll`) rather than driver web tabs: what those editors ask the
//! agent for, and what comes back.
//!
//! Every plugin talks to its agent the same way: `SendToDevice` to the agent's item with a
//! `<devicecommand>` (`GET_ALL_ENTRIES`, `GET_SCENE_LIST`, `get_announcements`, …), answered
//! synchronously with agent-specific XML. Writes are the same call with another command
//! (`ADD_ENTRY`, …); Director answers those with an empty reply, and the agent reports
//! `entry_added` / `command_failed` to the plugin afterwards, so a write is checked by
//! reading the project back, as every other op is.
//!
//! Learned from Composer Pro 3.3.3's plugins and checked against Director 3.3.3 (the
//! Virtual Director and a real EA-1). This module is protocol and parsing only: names are
//! resolved and things are worded for people in the app (`agent_view`).

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
        }
    }
}

/// A `<devicecommand>` as Composer's plugins build it. `params` are (name, type, value);
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

/// What a scheduled event's time is measured from (Composer's `OffsetType`).
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

/// Composer's "start on the Nth weekday of the month" (`StartPeriod`).
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

    /// The `<entry>` Composer sends in `ADD_ENTRY` / `MODIFY_ENTRY` (its `ScheduledEntry.ToXml`).
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

// ---- Advanced Lighting -------------------------------------------------------------------------

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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LightingStep {
    pub delay_ms: i64,
    /// Level 0–100 when the step sets one.
    pub level: Option<i64>,
    pub rate_ms: i64,
    /// Colour temperature in kelvin when the step sets a colour in that mode.
    pub color_temperature: Option<i64>,
    /// Hue/saturation when the step sets a colour (hue 0–360, saturation 0–100).
    pub color_hs: Option<(i64, i64)>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LightingMember {
    pub device: u32,
    pub steps: Vec<LightingStep>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LightingScene {
    pub id: u32,
    pub name: String,
    /// The scene's "(Toggle)" companion, if it has one.
    pub toggle_id: Option<u32>,
    pub active: bool,
    pub members: Vec<LightingMember>,
}

/// A `GET_SCENE` reply (`<AdvScene>`).
pub fn parse_scene(xml: &str) -> Option<LightingScene> {
    let doc = parse(xml)?;
    let s = doc.descendants().find(|n| n.has_tag_name("AdvScene"))?;
    let members = s
        .descendants()
        .filter(|n| n.has_tag_name("AdvSceneMember"))
        .map(|m| LightingMember {
            device: int(m, "device_id") as u32,
            steps: m
                .descendants()
                .filter(|e| e.has_tag_name("element"))
                .map(|e| {
                    let color = flag(e, "colorEnabled");
                    // colorMode 1 is a white (temperature) colour, otherwise hue/saturation.
                    let temp = color && int(e, "colorMode") == 1;
                    LightingStep {
                        delay_ms: int(e, "delay"),
                        level: flag(e, "levelEnabled").then(|| int(e, "level")),
                        rate_ms: int(e, "levelRate"),
                        color_temperature: temp.then(|| int(e, "colorTemperature")),
                        color_hs: (color && !temp).then(|| (int(e, "colorHue"), int(e, "colorSaturation"))),
                    }
                })
                .collect(),
        })
        .collect();
    let toggle = int(s, "toggle_id");
    Some(LightingScene {
        id: int(s, "scene_id") as u32,
        name: text(s, "name"),
        // 65535 is "none"; a toggle scene names itself or none.
        toggle_id: (child(s, "toggle_id").is_some() && toggle >= 0 && toggle != 65535 && toggle != int(s, "scene_id")).then_some(toggle as u32),
        active: flag(s, "is_active"),
        members,
    })
}

// ---- Announcements -----------------------------------------------------------------------------

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
    /// The sound played (a file on the controller, or a URL).
    pub audio: Option<String>,
    /// Text shown on screens.
    pub text: Option<String>,
    /// The image or camera shown on screens, with any credentials in it masked.
    pub image: Option<String>,
    pub rooms: Vec<AnnouncementTarget>,
    pub navigators: Vec<AnnouncementTarget>,
    pub touchscreens: Vec<AnnouncementTarget>,
}

/// `user:pass@` and `password=`-style query values replaced with `••••`: announcement
/// images are often camera URLs with the camera's login in them.
pub fn mask_url_credentials(url: &str) -> String {
    let mut out = url.to_string();
    if let Some(scheme) = out.find("://") {
        let rest = scheme + 3;
        let end = out[rest..].find(['/', '?', '#']).map(|e| rest + e).unwrap_or(out.len());
        if let Some(at) = out[rest..end].rfind('@') {
            out.replace_range(rest..rest + at, "••••");
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
                masked.push_str("••••");
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

/// A `get_announcements` reply.
pub fn parse_announcements(xml: &str) -> Vec<Announcement> {
    let Some(doc) = parse(xml) else { return vec![] };
    let targets = |a: Node<'_, '_>, list: &str, one: &str| -> Vec<AnnouncementTarget> {
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
    doc.descendants()
        .filter(|n| n.has_tag_name("announcement") && n.attribute("id").is_some())
        .map(|a| {
            let audio = child(a, "audio").map(|x| attr(x, "file")).filter(|s| !s.is_empty());
            let video = child(a, "video");
            Announcement {
                id: attr(a, "id").parse().unwrap_or(0),
                name: attr(a, "name"),
                audio: audio.map(|s| mask_url_credentials(&s)),
                text: video.map(|v| attr(v, "text")).filter(|s| !s.is_empty()),
                image: video.map(|v| attr(v, "file")).filter(|s| !s.is_empty()).map(|s| mask_url_credentials(&s)),
                rooms: targets(a, "rooms", "room"),
                navigators: targets(a, "navigators", "navigator"),
                touchscreens: targets(a, "touchscreens", "touchscreen"),
            }
        })
        .collect()
}

// ---- Wake/Sleep --------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WakeSleepScene {
    pub id: u32,
    pub room: u32,
    /// `HH:MM`
    pub wake_time: String,
    /// "all", or the days as the agent stores them.
    pub wake_days: String,
    /// Minutes the goodnight fade takes.
    pub sleep_minutes: i64,
    pub lights: Option<WakeSleepPart>,
    pub media: Option<WakeSleepPart>,
    pub blinds: Option<WakeSleepPart>,
    pub temperature: Option<WakeSleepPart>,
}

/// One part of a wake-up (lights, media, blinds, temperature), when shown to users.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WakeSleepPart {
    /// On by default when someone sets a wake-up.
    pub enabled: bool,
    /// The light, source or blind it uses (0 = none chosen).
    pub device: Option<u32>,
    pub detail: Option<String>,
}

/// A `GET_WAKEUPGOODNIGHTSCENE_LIST` reply.
pub fn parse_wake_sleep(xml: &str) -> Vec<WakeSleepScene> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants()
        .filter(|n| n.has_tag_name("scene") && n.attribute("roomid").is_some())
        .map(|s| {
            let part = |tag: &str, dev: &str, detail: Option<String>| {
                child(s, tag).filter(|p| p.attribute("visible").is_some_and(truthy)).map(|p| WakeSleepPart {
                    enabled: p.attribute("enabled_default").is_some_and(truthy),
                    device: p.attribute(dev).and_then(|v| v.parse().ok()).filter(|v| *v != 0),
                    detail: detail.filter(|d| !d.is_empty()),
                })
            };
            let w = child(s, "wakeuptime_default");
            let lights = child(s, "lights").and_then(|l| l.attribute("ramprate_default")).map(|r| format!("ramp {r} min"));
            let media = child(s, "media").and_then(|m| m.attribute("type_default")).map(String::from);
            let temp = child(s, "temp").map(|t| format!("{} {}", attr(t, "mode_default"), attr(t, "setpoint_default")).trim().to_string());
            WakeSleepScene {
                id: attr(s, "id").parse().unwrap_or(0),
                room: attr(s, "roomid").parse().unwrap_or(0),
                wake_time: w
                    .map(|w| format!("{:02}:{:02}", attr(w, "hour").parse::<u32>().unwrap_or(0), attr(w, "min").parse::<u32>().unwrap_or(0)))
                    .unwrap_or_default(),
                wake_days: w.map(|w| attr(w, "days_default")).unwrap_or_default(),
                sleep_minutes: child(s, "goodnighttime_default").and_then(|g| g.attribute("min")).and_then(|m| m.parse().ok()).unwrap_or(0),
                lights: part("lights", "lightid_default", lights),
                media: part("media", "sourceid_default", media),
                blinds: part("blinds", "blindid_default", None),
                temperature: part("temp", "", temp),
            }
        })
        .collect()
}

// ---- Push / email notification ----------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NotificationTemplate {
    pub id: u32,
    pub name: String,
    pub category: Option<u32>,
    pub severity: Option<u32>,
    pub subject: String,
    pub message: String,
    pub timestamp: bool,
    /// (owner device, attachment id): e.g. a camera snapshot.
    pub attachments: Vec<(u32, u32)>,
}

/// A `GET_TEMPLATE_LIST` reply (push notification; email lists carry id and name only).
pub fn parse_templates(xml: &str) -> Vec<NotificationTemplate> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants()
        .filter(|n| n.has_tag_name("template"))
        .map(|t| NotificationTemplate {
            id: int(t, "templateid") as u32,
            name: text(t, "name"),
            category: child(t, "category").map(|_| int(t, "category") as u32),
            severity: child(t, "severity").map(|_| int(t, "severity") as u32),
            subject: text(t, "subject"),
            message: text(t, "message"),
            timestamp: flag(t, "timestamp"),
            attachments: t
                .descendants()
                .filter(|a| a.has_tag_name("attachment"))
                .map(|a| (int(a, "owner") as u32, int(a, "id") as u32))
                .collect(),
        })
        .collect()
}

/// `GET_CATEGORY_LIST` / `GET_SEVERITY_LIST`: id → name.
pub fn parse_named_list(xml: &str, tag: &str) -> Vec<(u32, String)> {
    let Some(doc) = parse(xml) else { return vec![] };
    doc.descendants().filter(|n| n.has_tag_name(tag)).map(|n| (int(n, "id") as u32, text(n, "name"))).collect()
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
        let s = parse_scene("<AdvScene><name>Joseph's Room On</name><scene_id>2</scene_id><toggle_id>3</toggle_id><is_active>False</is_active><all_members><AdvSceneMember><device_id>1248</device_id><all_elements><element><delay>0</delay><levelEnabled>True</levelEnabled><levelRate>250</levelRate><level>100</level><colorEnabled>True</colorEnabled><colorMode>1</colorMode><colorTemperature>3200</colorTemperature></element></all_elements></AdvSceneMember></all_members></AdvScene>").unwrap();
        assert_eq!((s.toggle_id, s.members[0].device, s.members[0].steps[0].color_temperature), (Some(3), 1248, Some(3200)));
        let w = parse_wake_sleep(r#"<wakeupgoodnightscenes><scene id="1" roomid="71"><wakeuptime_default hour="7" min="30" days_default="all"/><goodnighttime_default min="60"/><lights visible="true" enabled_default="false" lightid_default="0" ramprate_default="1"/><blinds visible="false" enabled_default="false" blindid_default="0"/></scene></wakeupgoodnightscenes>"#);
        assert_eq!((w[0].room, w[0].wake_time.as_str(), w[0].blinds.is_none()), (71, "07:30", true));
        let t = parse_templates("<templates><template><templateid>2</templateid><name>Back Garage Stuck</name><category>2</category><severity>2</severity><subject>Open</subject><message/><timestamp>1</timestamp><attachments><attachment><owner>378</owner><id>1003</id></attachment></attachments></template></templates>");
        assert_eq!((t[0].id, t[0].attachments[0]), (2, (378, 1003)));
    }
}
