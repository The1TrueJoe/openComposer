//! Programming beyond plain device commands: conditionals (If), loops (While), Else, Delay,
//! Stop, Break, comments and variables — the code item kinds, the `cmdcond` XML Director takes
//! for each, the line text Composer stores, and where in a script each may go.
//!
//! Formats are Composer Pro 3.3's (Control4.Designer.Programming's variable controls and
//! Control4.Common's `DriverConditional.ToCommandXml`), checked against the 3.3.3 Virtual
//! Director, which stores them verbatim and answers `EnableCodeItem`/`MoveCodeItem` as noted
//! below. Not here: compound conditions (Composer's AND/OR expression builder,
//! `AddCodeItemToExpression`), conditionals on Device/Room/Media/Color variables, and the
//! value-taking conditionals of Control4's built-in proxies (see [`shape`]).

use serde::{Deserialize, Serialize};

use crate::director::{Catalog, ConditionalDef, PropertyDef};
use crate::model::{CodeItem, Project};
use crate::ops::{CodeParam, Op};
use crate::xml::escape;

/// Director's code item types (Composer's `CodeItemType`).
pub mod kind {
    pub const COMMAND: u32 = 1;
    pub const CONDITIONAL: u32 = 2;
    pub const LOOP: u32 = 3;
    /// A sibling right after its If; the else-branch is its children.
    pub const ELSE: u32 = 4;
    pub const COMMENT: u32 = 5;
    /// AND/OR inside a compound condition.
    pub const OPERATOR: u32 = 6;
}

/// The device id Composer files Else, Delay, Stop, Break and comments under (no real item).
pub const SYSTEM_DEVICE: u32 = 100000;
/// The Variables agent, which owns the project's own (user) variables.
pub const VARIABLES_AGENT: u32 = 100001;

/// A comparison. Drivers get it as `LOGIC` (`EQUAL`…); variables as `==`… (both Composer's).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Logic {
    #[serde(alias = "==", alias = "=")]
    Equal,
    #[serde(alias = "!=")]
    NotEqual,
    #[serde(alias = "<")]
    LessThan,
    #[serde(alias = "<=")]
    LessThanOrEqual,
    #[serde(alias = ">")]
    GreaterThan,
    #[serde(alias = ">=")]
    GreaterThanOrEqual,
}

impl Logic {
    pub const ALL: [Logic; 6] =
        [Logic::Equal, Logic::NotEqual, Logic::LessThan, Logic::LessThanOrEqual, Logic::GreaterThan, Logic::GreaterThanOrEqual];
    pub const EQUALITY: [Logic; 2] = [Logic::Equal, Logic::NotEqual];

    /// What a driver's `TestCondition` gets as `tParams.LOGIC`.
    pub fn driver(self) -> &'static str {
        match self {
            Logic::Equal => "EQUAL",
            Logic::NotEqual => "NOT_EQUAL",
            Logic::LessThan => "LESS_THAN",
            Logic::LessThanOrEqual => "LESS_THAN_OR_EQUAL",
            Logic::GreaterThan => "GREATER_THAN",
            Logic::GreaterThanOrEqual => "GREATER_THAN_OR_EQUAL",
        }
    }
    /// The `name` of a variable `<deviceconditional>`.
    pub fn symbol(self) -> &'static str {
        match self {
            Logic::Equal => "==",
            Logic::NotEqual => "!=",
            Logic::LessThan => "<",
            Logic::LessThanOrEqual => "<=",
            Logic::GreaterThan => ">",
            Logic::GreaterThanOrEqual => ">=",
        }
    }
    /// How a driver conditional's LOGIC reads in the line ("Greater Than").
    pub fn words(self) -> &'static str {
        match self {
            Logic::Equal => "Equal To",
            Logic::NotEqual => "Not Equal To",
            Logic::LessThan => "Less Than",
            Logic::LessThanOrEqual => "Less Than Or Equal To",
            Logic::GreaterThan => "Greater Than",
            Logic::GreaterThanOrEqual => "Greater Than Or Equal To",
        }
    }
    /// How a variable comparison reads ("GREATER THAN", Composer's `CompareOperation`).
    fn var_words(self) -> String {
        self.words().to_uppercase()
    }
}

/// A variable, by the device that owns it and its id (get_variables lists them).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct VarRef {
    pub device: u32,
    pub id: u32,
}

/// What an If or While tests.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Condition {
    /// One of a device's conditionals (get_item lists them under `conditionals`, with the
    /// comparisons and parameters each takes).
    Device {
        target: u32,
        name: String,
        #[serde(default)]
        logic: Option<Logic>,
        /// Usually one, `VALUE`.
        #[serde(default)]
        params: Vec<CodeParam>,
    },
    /// A variable compared with a value (`true`/`false` for a Boolean) or with another variable.
    Variable {
        variable: VarRef,
        #[serde(default = "equal")]
        logic: Logic,
        #[serde(default)]
        value: Option<String>,
        #[serde(default)]
        other: Option<VarRef>,
        /// The variable's type, looked up when the change is proposed.
        #[serde(default, skip_serializing_if = "is_zero")]
        #[schemars(skip)]
        var_type: u32,
    },
}

fn equal() -> Logic {
    Logic::Equal
}
fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// Composer's programming controls that aren't about a device.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Control {
    /// Wait before the next line.
    Delay { ms: u32 },
    /// Stop running this event's script (Composer's Stop).
    Stop,
    /// Leave the innermost While loop (Composer's Break).
    Break,
    /// A note in the script; Director doesn't run it.
    Comment { text: String },
}

/// What a variable line does to its variable.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VarAction {
    /// Set it to a value (`true`/`false` for a Boolean).
    Set { value: String },
    /// Set it to another variable's value.
    Copy { from: VarRef },
    /// Flip a Boolean.
    Toggle,
    Add { value: String },
    Subtract { value: String },
    Multiply { value: String },
    Divide { value: String },
    /// A random number between `min` and `max`.
    Random { min: String, max: String },
}

/// Variable types programming can use (Composer's `VariableType`).
pub mod var_type {
    pub const STRING: u32 = 1;
    pub const NUMBER: u32 = 2;
    pub const FLOAT: u32 = 3;
    pub const BOOLEAN: u32 = 4;
    pub fn label(t: u32) -> &'static str {
        match t {
            STRING => "String",
            NUMBER => "Number",
            FLOAT => "Float",
            BOOLEAN => "Boolean",
            5 => "Level",
            6 => "State",
            7 => "Date",
            8 => "Time",
            9 => "Room",
            10 => "Media",
            11 => "List",
            12 => "ULONG",
            13 => "XML",
            14 => "Device",
            15 => "Color",
            _ => "Unknown",
        }
    }
    /// Whether openComposer can program it (the four Composer's simple controls handle).
    pub fn programmable(t: u32) -> bool {
        matches!(t, STRING | NUMBER | FLOAT | BOOLEAN)
    }
    /// The `type` Composer writes on a variable line's `<param>`.
    pub(crate) fn xml(t: u32) -> &'static str {
        match t {
            STRING => "string",
            FLOAT => "floatingpoint",
            _ => "int",
        }
    }
}

// ---- driver conditionals -------------------------------------------------------------------

/// What a conditional takes in programming: the comparisons on offer and its parameters.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Shape {
    pub logic: Vec<Logic>,
    pub params: Vec<PropertyDef>,
    /// Why openComposer can't add it, when it can't.
    pub unsupported: Option<String>,
}

fn param(name: &str, prop_type: &str) -> PropertyDef {
    PropertyDef { name: name.into(), prop_type: prop_type.into(), ..Default::default() }
}

/// The words of a description template that stand for values (`INTEGER`, `STRING`, `BTN_NAME`…).
fn macros(description: &str) -> Vec<&str> {
    description
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| w.len() > 2 && w.chars().all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit()))
        .filter(|w| *w != "NAME")
        .collect()
}

/// A conditional's comparisons and parameters. DriverWorks drivers declare a `<type>`
/// (SIMPLE, BOOL, NUMBER, STRING, LIST, ROOM, DEVICE) and get `LOGIC`/`VALUE` in
/// `TestCondition`. Control4's built-in proxies declare none; Composer hard-codes their
/// editors, so only the ones without values (LOAD_ON "NAME is on") can be added here.
/// ponytail: proxy conditionals with values (light_v2 IS_BRIGHTNESS_CURRENT, a TV's input) are
/// listed but refused; the upgrade is their parameter names, read from Composer's per-proxy
/// controls or a Composer log of one being added.
pub fn shape(def: &ConditionalDef) -> Shape {
    let value = |t: &str| {
        let mut p = param("VALUE", t);
        p.minimum = def.minimum.clone();
        p.maximum = def.maximum.clone();
        p
    };
    let unsupported = |why: String| Shape { unsupported: Some(why), ..Default::default() };
    if def.name.trim().is_empty() {
        return unsupported(format!(
            "“{}” is one of Control4's built-in conditionals that Director knows by number only; openComposer can't add it yet",
            def.description
        ));
    }
    match def.kind.as_str() {
        "SIMPLE" => Shape::default(),
        "BOOL" | "BOOLEAN" => {
            let mut p = param("VALUE", "LIST");
            p.items = vec![def.true_text.clone().unwrap_or_else(|| "True".into()), def.false_text.clone().unwrap_or_else(|| "False".into())];
            Shape { params: vec![p], ..Default::default() }
        }
        "NUMBER" => Shape { logic: Logic::ALL.to_vec(), params: vec![value("INTEGER")], unsupported: None },
        "STRING" => Shape { logic: Logic::EQUALITY.to_vec(), params: vec![value("STRING")], unsupported: None },
        "LIST" => {
            let mut p = value("LIST");
            p.items = def.items.clone();
            Shape { logic: Logic::EQUALITY.to_vec(), params: vec![p], unsupported: None }
        }
        "ROOM" => Shape { logic: Logic::EQUALITY.to_vec(), params: vec![value("ROOM")], unsupported: None },
        "DEVICE" => Shape { logic: Logic::EQUALITY.to_vec(), params: vec![value("DEVICE")], unsupported: None },
        "" => {
            let m = macros(&def.description);
            if m.is_empty() {
                Shape::default()
            } else {
                unsupported(format!(
                    "“{}” takes values ({}) that Control4's built-in proxy expects in a form openComposer doesn't know yet",
                    def.description,
                    m.join(", ")
                ))
            }
        }
        other => unsupported(format!("conditional type {other} isn't supported yet")),
    }
}

/// The macro in a typed conditional's description that its VALUE fills in.
fn value_macro(description: &str) -> Option<&str> {
    ["INTEGER", "NUMBER", "STRING", "DEVICE", "ROOM", "VALUE"].into_iter().find(|m| macros(description).contains(m))
}

impl Condition {
    /// The device the line is about (`idcmdconddevice`): the target, or the variable's owner.
    pub fn device(&self) -> u32 {
        match self {
            Condition::Device { target, .. } => *target,
            Condition::Variable { variable, .. } => variable.device,
        }
    }

    /// The `cmdcond` Director stores and evaluates.
    pub fn xml(&self) -> String {
        match self {
            Condition::Device { name, logic, params, .. } => {
                let mut x = format!(r#"<deviceconditional owneridtype="" owneriditem="-1"><name>{}</name>"#, escape(name));
                if let Some(l) = logic {
                    x.push_str(&format!("<conditional>{}</conditional>", l.driver()));
                }
                if !params.is_empty() {
                    x.push_str("<params>");
                    for p in params {
                        x.push_str(&format!(
                            r#"<param><name>{}</name><value type="{}"><static>{}</static></value></param>"#,
                            escape(&p.name),
                            escape(&p.r#type),
                            escape(&p.value)
                        ));
                    }
                    x.push_str("</params>");
                }
                x.push_str("</deviceconditional>");
                x
            }
            Condition::Variable { variable, logic, value, other, var_type } => {
                let t = var_type::xml(*var_type);
                let body = match other {
                    Some(o) => var_ref_params(t, o),
                    None => format!(r#"<param name="value" type="{t}">{}</param>"#, escape(value.as_deref().unwrap_or_default())),
                };
                format!(
                    r#"<deviceconditional owneridtype="variable" owneriditem="{}" name="{}">{body}</deviceconditional>"#,
                    variable.id,
                    escape(logic.symbol())
                )
            }
        }
    }

    /// The line as Composer stores it: "If NAME is on", or a `#!` template for a variable.
    /// `def` is the device conditional's definition (its description is the template).
    pub fn display(&self, word: &str, def: Option<&ConditionalDef>) -> String {
        match self {
            Condition::Device { name, logic, params, .. } => {
                let mut t = def.map(|d| d.description.trim().to_string()).filter(|d| !d.is_empty()).unwrap_or_else(|| format!("NAME {name}"));
                if let Some(l) = logic {
                    t = replace_word(&t, "LOGIC", l.words());
                }
                let typed = def.is_some_and(|d| !d.kind.is_empty());
                for p in params {
                    let key = if typed && p.name == "VALUE" { value_macro(&t).unwrap_or("VALUE").to_string() } else { p.name.clone() };
                    t = replace_word(&t, &key, &p.value);
                }
                format!("{word} {t}")
            }
            Condition::Variable { variable, logic, value, other, var_type } => {
                let me = vname(variable);
                match other {
                    Some(o) => encode(
                        &format!("{word} {{VNAME}} is {} the value in {{COMP_VNAME}}", logic.var_words()),
                        &[("VNAME", me), ("COMP_VNAME", vname(o))],
                    ),
                    None if *var_type == var_type::BOOLEAN => {
                        let truth = if value.as_deref() == Some("1") { "True" } else { "False" };
                        encode(&format!("{word} {{VNAME}} is {truth}"), &[("VNAME", me)])
                    }
                    None => encode(&format!("{word} {{VNAME}} {} {}", logic.var_words(), value.as_deref().unwrap_or_default()), &[("VNAME", me)]),
                }
            }
        }
    }
}

fn var_ref_params(t: &str, o: &VarRef) -> String {
    format!(
        r#"<param name="variable" type="{t}" /><param name="deviceid" type="int">{}</param><param name="variableid" type="int">{}</param>"#,
        o.device, o.id
    )
}

/// Replace `word` where it stands alone (so NAME doesn't hit BTN_NAME).
fn replace_word(s: &str, word: &str, with: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find(word) {
        let before_ok = rest[..i].chars().last().is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
        let after = &rest[i + word.len()..];
        let after_ok = after.chars().next().is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
        out.push_str(&rest[..i]);
        out.push_str(if before_ok && after_ok { with } else { word });
        rest = after;
    }
    out.push_str(rest);
    out
}

// ---- control lines and variable commands ---------------------------------------------------

impl Control {
    /// (kind, display, cmdcond), as Composer's palette makes them.
    pub fn parts(&self) -> (u32, String, String) {
        match self {
            Control::Delay { ms } => {
                let (n, unit) = if *ms >= 60_000 && ms % 60_000 == 0 {
                    (ms / 60_000, "minute")
                } else if *ms >= 1000 && ms % 1000 == 0 {
                    (ms / 1000, "second")
                } else {
                    (*ms, "millisecond")
                };
                let display = format!("delay {n} {unit}{}", if n == 1 { "" } else { "s" });
                let xml = format!(
                    r#"<devicecommand><command>DELAY</command><params><param><name>time</name><value type="INT"><static>{ms}</static></value></param></params></devicecommand>"#
                );
                (kind::COMMAND, display, xml)
            }
            Control::Stop => (kind::COMMAND, "Stop".into(), "<devicecommand><command>RETURN</command></devicecommand>".into()),
            Control::Break => (kind::COMMAND, "Break".into(), "<devicecommand><command>BREAK</command></devicecommand>".into()),
            Control::Comment { text } => (kind::COMMENT, text.clone(), String::new()),
        }
    }
}

impl VarAction {
    fn op_name(&self) -> &'static str {
        match self {
            VarAction::Set { .. } | VarAction::Copy { .. } => "=",
            VarAction::Toggle => "toggle",
            VarAction::Add { .. } => "+",
            VarAction::Subtract { .. } => "-",
            VarAction::Multiply { .. } => "*",
            VarAction::Divide { .. } => "/",
            VarAction::Random { .. } => "rand",
        }
    }

    /// The `cmdcond` of a line that changes `var` (of type `t`).
    pub fn xml(&self, var: &VarRef, t: u32) -> String {
        let ty = var_type::xml(t);
        let body = match self {
            VarAction::Toggle => String::new(),
            VarAction::Copy { from } => var_ref_params(ty, from),
            VarAction::Random { min, max } => format!(r#"<param name="value" type="{ty}">{}, {}</param>"#, escape(min), escape(max)),
            VarAction::Set { value } | VarAction::Add { value } | VarAction::Subtract { value } | VarAction::Multiply { value } | VarAction::Divide { value } => {
                format!(r#"<param name="value" type="{ty}">{}</param>"#, escape(value))
            }
        };
        format!(r#"<devicecommand owneridtype="variable" owneriditem="{}" name="{}">{body}</devicecommand>"#, var.id, escape(self.op_name()))
    }

    /// The line as Composer stores it (a `#!` template naming the variable).
    pub fn display(&self, var: &VarRef, t: u32) -> String {
        let me = || vec![("VNAME", vname(var))];
        match self {
            VarAction::Set { value } if t == var_type::BOOLEAN => {
                encode(&format!("{{VNAME}} = {}", if value == "1" { "True" } else { "False" }), &me())
            }
            VarAction::Set { value } => encode(&format!("{{VNAME}} = {value}"), &me()),
            VarAction::Copy { from } => encode("Set {VNAME} to the value of {SRC_VNAME}", &[("VNAME", vname(var)), ("SRC_VNAME", vname(from))]),
            VarAction::Toggle => encode("Toggle {VNAME}", &me()),
            VarAction::Random { min, max } => encode(&format!("{{VNAME}} = Random Number Between {min} and {max}"), &me()),
            VarAction::Add { value } | VarAction::Subtract { value } | VarAction::Multiply { value } | VarAction::Divide { value } => {
                encode(&format!("{{VNAME}} = {{VNAME}} {} {value}", self.op_name()), &me())
            }
        }
    }
}

// ---- `#!` line templates ---------------------------------------------------------------------

fn vname(v: &VarRef) -> String {
    format!("VNAME:{},{}", v.device, v.id)
}

/// Composer's `encodeCodeItemDescription`: `#!"text with {KEY}";KEY="VNAME:d,v";…`.
fn encode(text: &str, vars: &[(&str, String)]) -> String {
    let q = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let mut out = format!("#!\"{}\"", q(text));
    for (k, v) in vars {
        out.push_str(&format!(";{k}=\"{}\"", q(v)));
    }
    out
}

/// A quoted string from `s` (just past its opening quote): the text and what follows it.
fn read_quoted(s: &str) -> Option<(String, &str)> {
    let mut out = String::new();
    let mut chars = s.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '\\' => {
                if let Some((_, n)) = chars.next() {
                    out.push(n);
                }
            }
            '"' => return Some((out, &s[i + 1..])),
            c => out.push(c),
        }
    }
    None
}

/// A stored line as people read it: Composer's `#!` templates expanded (variable, device and
/// room references named) and NAME replaced by the line's device.
pub fn render(display: &str, device: u32, p: &Project) -> String {
    let Some(rest) = display.strip_prefix("#!\"") else {
        return if display.contains("NAME") { replace_word(display, "NAME", &p.name_of(device)) } else { display.to_string() };
    };
    let Some((text, mut rest)) = read_quoted(rest) else { return display.to_string() };
    let mut vars = std::collections::HashMap::new();
    while let Some(r) = rest.strip_prefix(';') {
        let Some((key, r)) = r.split_once("=\"") else { break };
        let Some((val, r)) = read_quoted(r) else { break };
        vars.insert(key.to_string(), val);
        rest = r;
    }
    let mut out = String::new();
    let mut s = text.as_str();
    while let Some(i) = s.find('{') {
        out.push_str(&s[..i]);
        match s[i..].find('}') {
            Some(j) => {
                let key = &s[i + 1..i + j];
                match vars.get(key) {
                    Some(v) => out.push_str(&reference(v, p)),
                    None => out.push_str(&s[i..=i + j]),
                }
                s = &s[i + j + 1..];
            }
            None => {
                out.push_str(&s[i..]);
                s = "";
            }
        }
    }
    out.push_str(s);
    if out.contains("NAME") { replace_word(&out, "NAME", &p.name_of(device)) } else { out }
}

/// `VNAME:dev,var`, `DEV:id,…`, `RNAME:id` in a `#!` template, named.
fn reference(v: &str, p: &Project) -> String {
    let ids = |s: &str| s.split(',').filter_map(|x| x.trim().parse::<u32>().ok()).collect::<Vec<_>>();
    if let Some(r) = v.strip_prefix("VNAME:").or_else(|| v.strip_prefix("VAR:")) {
        if let [d, id, ..] = ids(r)[..] {
            return variable_name(p, d, id);
        }
    } else if let Some(r) = v.strip_prefix("DEV:") {
        return ids(r).into_iter().map(|d| p.name_of(d)).collect::<Vec<_>>().join(", ");
    } else if let Some(r) = v.strip_prefix("RNAME:") {
        if let Some(d) = ids(r).first() {
            return p.name_of(*d);
        }
    }
    v.to_string()
}

/// A variable as a line names it: the project's own by name, a device's as "Device->NAME".
pub fn variable_name(p: &Project, device: u32, id: u32) -> String {
    let name = p.variables.iter().find(|v| v.device == device && v.id == id).map(|v| v.name.clone()).unwrap_or_else(|| format!("variable {id}"));
    if device == VARIABLES_AGENT || p.item(device).is_none() { name } else { format!("{}->{name}", p.name_of(device)) }
}

/// What a line is, for people and the UI: `command`, `if`, `while`, `else`, `comment`,
/// `delay`, `stop`, `break`, `variable` or `operator`.
pub fn role(c: &CodeItem) -> &'static str {
    match c.kind {
        kind::CONDITIONAL => "if",
        kind::LOOP => "while",
        kind::ELSE => "else",
        kind::COMMENT => "comment",
        kind::OPERATOR => "operator",
        _ if c.cmdcond.contains(r#"owneridtype="variable""#) => "variable",
        _ if c.cmdcond.contains("<command>DELAY</command>") => "delay",
        _ if c.cmdcond.contains("<command>RETURN</command>") => "stop",
        _ if c.cmdcond.contains("<command>BREAK</command>") => "break",
        _ => "command",
    }
}

/// Lines can be nested only under these (Composer's tree takes drops nowhere else).
pub fn is_block(kind: u32) -> bool {
    matches!(kind, kind::CONDITIONAL | kind::LOOP | kind::ELSE)
}

// ---- completing and checking ops -------------------------------------------------------------

/// Fill in what an op leaves to the project and its drivers (a line's text, a variable's
/// type) and check it against them: the conditional exists and takes these values, the
/// variable exists and can be set. Runs before an op is predicted or sent.
pub fn complete(op: &mut Op, p: &Project, cat: &Catalog) -> Result<(), String> {
    match op {
        Op::AddConditional { r#loop, condition, display, .. } => {
            let word = if *r#loop { "While" } else { "If" };
            match condition {
                Condition::Device { target, name, logic, params } => {
                    let who = p.name_of(*target);
                    let info = cat.devices.get(target).ok_or_else(|| format!("“{who}” has no driver definition to take conditionals from"))?;
                    let def = info.conditionals.iter().find(|c| c.name == *name).ok_or_else(|| {
                        let have: Vec<&str> = info.conditionals.iter().filter(|c| !c.name.is_empty()).map(|c| c.name.as_str()).collect();
                        if have.is_empty() {
                            format!("“{who}” has no conditionals")
                        } else {
                            format!("“{who}” has no conditional “{name}”; its conditionals are: {}", have.join(", "))
                        }
                    })?;
                    let s = shape(def);
                    if let Some(why) = s.unsupported {
                        return Err(why);
                    }
                    match (s.logic.is_empty(), *logic) {
                        (true, Some(_)) => return Err(format!("“{name}” takes no comparison; leave logic out")),
                        (false, None) => *logic = Some(Logic::Equal),
                        (false, Some(l)) if !s.logic.contains(&l) => {
                            return Err(format!("“{name}” can only compare with: {}", s.logic.iter().map(|l| l.driver()).collect::<Vec<_>>().join(", ")));
                        }
                        _ => {}
                    }
                    let mut out = Vec::new();
                    for want in &s.params {
                        let given = params.iter().find(|x| x.name.eq_ignore_ascii_case(&want.name)).ok_or_else(|| {
                            format!("“{name}” needs a value for {}{}", want.name, if want.items.is_empty() { String::new() } else { format!(" (one of: {})", want.items.join(", ")) })
                        })?;
                        check_value(name, want, &given.value)?;
                        // Composer sends every conditional value as a STRING static.
                        out.push(CodeParam { name: want.name.clone(), r#type: "STRING".into(), value: given.value.clone() });
                    }
                    if let Some(extra) = params.iter().find(|x| !s.params.iter().any(|w| w.name.eq_ignore_ascii_case(&x.name))) {
                        return Err(format!("“{name}” has no parameter {}", extra.name));
                    }
                    *params = out;
                    if display.trim().is_empty() {
                        *display = condition_display(condition, word, Some(def));
                    }
                }
                Condition::Variable { variable, logic, value, other, var_type: t } => {
                    let v = find_var(p, variable)?;
                    *t = v.var_type;
                    let allowed: &[Logic] = match v.var_type {
                        var_type::NUMBER | var_type::FLOAT => &Logic::ALL,
                        var_type::STRING | var_type::BOOLEAN => &Logic::EQUALITY,
                        other => return Err(format!("{} variables can't be tested here yet", var_type::label(other))),
                    };
                    if !allowed.contains(logic) {
                        return Err(format!("a {} variable can only be compared with: equal, not_equal", var_type::label(v.var_type)));
                    }
                    match (other, value.as_mut()) {
                        (Some(o), _) => {
                            find_var(p, o)?;
                            *value = None;
                        }
                        (None, Some(val)) => {
                            *val = normalize(v.var_type, val)?;
                            if v.var_type == var_type::BOOLEAN && *logic == Logic::NotEqual {
                                // Composer offers "is True" / "is False" only.
                                *val = if val == "1" { "0".into() } else { "1".into() };
                                *logic = Logic::Equal;
                            }
                        }
                        (None, None) => return Err(format!("say what to compare “{}” with: a value, or another variable", v.name)),
                    }
                    if display.trim().is_empty() {
                        *display = condition_display(condition, word, None);
                    }
                }
            }
        }
        Op::AddVariableCommand { variable, action, display, var_type: t, .. } => {
            let v = find_var(p, variable)?;
            if v.readonly {
                return Err(format!("“{}” is read-only; its driver sets it", v.name));
            }
            *t = v.var_type;
            if !var_type::programmable(v.var_type) {
                return Err(format!("{} variables can't be set here yet", var_type::label(v.var_type)));
            }
            let numeric = matches!(v.var_type, var_type::NUMBER | var_type::FLOAT);
            match action {
                VarAction::Toggle if v.var_type != var_type::BOOLEAN => return Err(format!("only a Boolean can be toggled; “{}” is a {}", v.name, var_type::label(v.var_type))),
                VarAction::Add { .. } | VarAction::Subtract { .. } | VarAction::Multiply { .. } | VarAction::Divide { .. } | VarAction::Random { .. } if !numeric => {
                    return Err(format!("arithmetic needs a Number or Float; “{}” is a {}", v.name, var_type::label(v.var_type)));
                }
                VarAction::Set { value } | VarAction::Add { value } | VarAction::Subtract { value } | VarAction::Multiply { value } | VarAction::Divide { value } => {
                    *value = normalize(v.var_type, value)?;
                }
                VarAction::Random { min, max } => {
                    *min = normalize(v.var_type, min)?;
                    *max = normalize(v.var_type, max)?;
                }
                VarAction::Copy { from } => {
                    find_var(p, from)?;
                }
                VarAction::Toggle => {}
            }
            if display.trim().is_empty() {
                *display = action.display(variable, v.var_type);
            }
        }
        Op::AddControl { control, .. } => match control {
            Control::Delay { ms: 0 } => return Err("a delay needs a length (ms)".into()),
            Control::Comment { text } if text.trim().is_empty() => return Err("a comment needs some text".into()),
            _ => {}
        },
        _ => {}
    }
    Ok(())
}

/// The text of a new If/While line (what [`complete`] fills in, and predictions fall back to).
pub fn condition_display(c: &Condition, word: &str, def: Option<&ConditionalDef>) -> String {
    c.display(word, def)
}

fn find_var<'a>(p: &'a Project, r: &VarRef) -> Result<&'a crate::model::Variable, String> {
    p.variables
        .iter()
        .find(|v| v.device == r.device && v.id == r.id)
        .ok_or_else(|| format!("{} has no variable #{} (get_variables lists them)", p.name_of(r.device), r.id))
}

/// A value as Director wants it for a variable of type `t`: Booleans as 1/0, numbers parsed.
fn normalize(t: u32, v: &str) -> Result<String, String> {
    let v = v.trim();
    match t {
        var_type::BOOLEAN => match v.to_ascii_lowercase().as_str() {
            "1" | "true" | "on" | "yes" => Ok("1".into()),
            "0" | "false" | "off" | "no" => Ok("0".into()),
            _ => Err(format!("“{v}” isn't true or false")),
        },
        var_type::NUMBER => v.parse::<i64>().map(|n| n.to_string()).map_err(|_| format!("“{v}” isn't a whole number")),
        var_type::FLOAT => v.parse::<f64>().map(|_| v.to_string()).map_err(|_| format!("“{v}” isn't a number")),
        _ => Ok(v.to_string()),
    }
}

fn check_value(cond: &str, want: &PropertyDef, v: &str) -> Result<(), String> {
    if !want.items.is_empty() && !want.items.iter().any(|i| i == v) {
        return Err(format!("“{cond}” {} must be one of: {}", want.name, want.items.join(", ")));
    }
    if matches!(want.prop_type.as_str(), "INTEGER" | "ROOM" | "DEVICE") {
        let n: f64 = v.trim().parse().map_err(|_| format!("“{cond}” {} needs a number", want.name))?;
        let bound = |b: &Option<String>| b.as_deref().and_then(|x| x.parse::<f64>().ok());
        if bound(&want.minimum).is_some_and(|m| n < m) || bound(&want.maximum).is_some_and(|m| n > m) {
            return Err(format!(
                "“{cond}” {} must be between {} and {}",
                want.name,
                want.minimum.clone().unwrap_or_default(),
                want.maximum.clone().unwrap_or_default()
            ));
        }
    }
    Ok(())
}

// ---- where lines may go ----------------------------------------------------------------------

/// The lines under `parent` (0 = the event's top level), checked to be a block.
pub(crate) fn siblings_mut(code: &mut Vec<CodeItem>, parent: u32) -> Result<&mut Vec<CodeItem>, String> {
    if parent == 0 {
        return Ok(code);
    }
    let it = find_mut(code, parent).ok_or_else(|| format!("no programming line #{parent} under that event"))?;
    if !is_block(it.kind) {
        return Err(format!("lines can only go inside an If, While or Else; #{parent} “{}” is none of those", it.display));
    }
    Ok(&mut it.children)
}

pub(crate) fn find_mut(code: &mut [CodeItem], id: u32) -> Option<&mut CodeItem> {
    for c in code.iter_mut() {
        if c.id == id {
            return Some(c);
        }
        if let Some(f) = find_mut(&mut c.children, id) {
            return Some(f);
        }
    }
    None
}

pub(crate) fn find<'a>(code: &'a [CodeItem], id: u32) -> Option<&'a CodeItem> {
    for c in code {
        if c.id == id {
            return Some(c);
        }
        if let Some(f) = find(&c.children, id) {
            return Some(f);
        }
    }
    None
}

/// Where `line` goes among `siblings` (before `before`, 0 = the end), or why it can't: nothing
/// goes between an If and its Else, and an Else goes only right after an If that has none.
pub(crate) fn position(siblings: &[CodeItem], before: u32, line_kind: u32) -> Result<usize, String> {
    let pos = if before == 0 {
        siblings.len()
    } else {
        siblings.iter().position(|c| c.id == before).ok_or_else(|| format!("line #{before} isn't at that level of the script"))?
    };
    if siblings.get(pos).is_some_and(|c| c.kind == kind::ELSE) {
        return Err("nothing can go between an If and its Else".into());
    }
    if line_kind == kind::ELSE && !pos.checked_sub(1).and_then(|i| siblings.get(i)).is_some_and(|c| c.kind == kind::CONDITIONAL) {
        return Err("an Else goes right after an If (one without an Else already)".into());
    }
    Ok(pos)
}

/// Take line `id` out of the script, with the Else that belongs to it when it's an If
/// (Director moves and removes them together). Returns them, If first.
pub(crate) fn detach(code: &mut Vec<CodeItem>, id: u32) -> Option<Vec<CodeItem>> {
    if let Some(pos) = code.iter().position(|c| c.id == id) {
        let mut out = vec![code.remove(pos)];
        if out[0].kind == kind::CONDITIONAL && code.get(pos).is_some_and(|c| c.kind == kind::ELSE) {
            out.push(code.remove(pos));
        }
        return Some(out);
    }
    code.iter_mut().find_map(|c| detach(&mut c.children, id))
}

/// Every id in these lines and under them.
pub(crate) fn ids(code: &[CodeItem], out: &mut Vec<u32>) {
    for c in code {
        out.push(c.id);
        ids(&c.children, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(name: &str, kind: &str, description: &str) -> ConditionalDef {
        ConditionalDef { name: name.into(), kind: kind.into(), description: description.into(), ..Default::default() }
    }

    #[test]
    fn device_conditional_xml_and_text() {
        let c = Condition::Device { target: 1239, name: "LOAD_ON".into(), logic: None, params: vec![] };
        assert_eq!(c.xml(), r#"<deviceconditional owneridtype="" owneriditem="-1"><name>LOAD_ON</name></deviceconditional>"#);
        assert_eq!(c.display("If", Some(&def("LOAD_ON", "", "NAME is on"))), "If NAME is on");
        let n = Condition::Device {
            target: 5,
            name: "NUMBER_LIGHT_LEVEL".into(),
            logic: Some(Logic::GreaterThan),
            params: vec![CodeParam { name: "VALUE".into(), r#type: "STRING".into(), value: "50".into() }],
        };
        assert_eq!(
            n.xml(),
            r#"<deviceconditional owneridtype="" owneriditem="-1"><name>NUMBER_LIGHT_LEVEL</name><conditional>GREATER_THAN</conditional><params><param><name>VALUE</name><value type="STRING"><static>50</static></value></param></params></deviceconditional>"#
        );
        assert_eq!(n.display("While", Some(&def("NUMBER_LIGHT_LEVEL", "NUMBER", "NAME is LOGIC INTEGER"))), "While NAME is Greater Than 50");
    }

    #[test]
    fn shapes_follow_the_declared_type() {
        assert!(shape(&def("LOAD_ON", "", "NAME is on")).unsupported.is_none());
        assert!(shape(&def("IS_BRIGHTNESS_CURRENT", "", "NAME current brightness LOGIC VALUE TYPE")).unsupported.is_some());
        assert!(shape(&def("", "", "the NAME is on")).unsupported.is_some(), "id-only proxy conditionals");
        let mut b = def("BOOL_LIGHT", "BOOL", "NAME Light is STRING");
        b.true_text = Some("On".into());
        b.false_text = Some("Off".into());
        assert_eq!(shape(&b).params[0].items, ["On", "Off"]);
        assert_eq!(shape(&def("N", "NUMBER", "NAME is LOGIC INTEGER")).logic.len(), 6);
    }

    #[test]
    fn variable_lines_match_composer() {
        let v = VarRef { device: 100001, id: 1125 };
        let c = Condition::Variable { variable: v, logic: Logic::Equal, value: Some("1".into()), other: None, var_type: var_type::BOOLEAN };
        assert_eq!(c.xml(), r#"<deviceconditional owneridtype="variable" owneriditem="1125" name="=="><param name="value" type="int">1</param></deviceconditional>"#);
        assert_eq!(c.display("If", None), r#"#!"If {VNAME} is True";VNAME="VNAME:100001,1125""#);
        assert_eq!(VarAction::Toggle.xml(&v, var_type::BOOLEAN), r#"<devicecommand owneridtype="variable" owneriditem="1125" name="toggle"></devicecommand>"#);
        assert_eq!(VarAction::Add { value: "5".into() }.display(&v, var_type::NUMBER), r#"#!"{VNAME} = {VNAME} + 5";VNAME="VNAME:100001,1125""#);
    }

    #[test]
    fn templates_render_with_names() {
        let mut p = Project::default();
        p.variables.push(crate::model::Variable {
            device: 100001, id: 1125, name: "Garage Timer".into(), var_type: 4, readonly: false, hidden: false,
            description: String::new(), value: "1".into(),
        });
        assert_eq!(render(r#"#!"If {VNAME} is True";VNAME="VNAME:100001,1125""#, 100001, &p), "If Garage Timer is True");
        assert_eq!(render(r#"#!"Say \"hi\" to {X}";X="nothing""#, 0, &p), r#"Say "hi" to nothing"#);
        assert_eq!(Control::Delay { ms: 5000 }.parts().1, "delay 5 seconds");
        assert_eq!(Control::Delay { ms: 1500 }.parts().1, "delay 1500 milliseconds");
        assert_eq!(replace_word("NAME BTN_NAME is pressed", "NAME", "Lamp"), "Lamp BTN_NAME is pressed");
    }
}
