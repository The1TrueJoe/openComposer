//! Reading drivers' Lua output (what a driver's `print` shows in Composer's Lua tab).
//!
//! Director only pushes these lines live, as `OnDataToUI` events carrying `LUA_OUTPUT`, so
//! this keeps the last few per device in a ring buffer for as long as a connection lives.
//! It does not send anything and does not ask Director to turn Lua output on.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

/// Lines a driver printed, per device, newest last.
#[derive(Clone, Default)]
pub struct LuaLog {
    inner: Arc<Mutex<LuaLogInner>>,
}

#[derive(Default)]
struct LuaLogInner {
    seq: u64,
    lines: BTreeMap<u32, VecDeque<LuaLine>>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct LuaLine {
    /// Counts lines seen since openComposer connected; lets a caller tell new from old.
    pub seq: u64,
    /// Director's timestamp (seconds since 1970), 0 if the event had none.
    pub time: u64,
    pub text: String,
}

const KEEP_PER_DEVICE: usize = 500;

impl LuaLog {
    pub fn push(&self, device: u32, time: u64, text: String) {
        let mut g = self.inner.lock().unwrap();
        g.seq += 1;
        let seq = g.seq;
        let q = g.lines.entry(device).or_default();
        q.push_back(LuaLine { seq, time, text });
        while q.len() > KEEP_PER_DEVICE {
            q.pop_front();
        }
    }

    /// The sequence number of the newest line seen so far (0 if none).
    pub fn mark(&self) -> u64 {
        self.inner.lock().unwrap().seq
    }

    pub fn lines(&self, device: u32, contains: Option<&str>) -> Vec<LuaLine> {
        let g = self.inner.lock().unwrap();
        g.lines
            .get(&device)
            .map(|q| q.iter().filter(|l| contains.is_none_or(|c| l.text.contains(c))).cloned().collect())
            .unwrap_or_default()
    }
}

/// `(device, time, text)` from an `OnDataToUI` event that carries `LUA_OUTPUT`; `None` for any other.
pub fn parse_lua_output(raw: &str) -> Option<(u32, u64, String)> {
    if !raw.contains("LUA_OUTPUT") {
        return None;
    }
    let doc = roxmltree::Document::parse(raw).ok()?;
    let param = |name: &str| doc.descendants().find(|n| n.has_tag_name("param") && n.attribute("name") == Some(name));
    let device = param("iddevice")?.text()?.trim().parse().ok()?;
    let time = param("time").and_then(|p| p.text()).and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    let cmd = doc.descendants().find(|n| n.has_tag_name("devicecommand"))?;
    if cmd.children().find(|c| c.has_tag_name("command"))?.text()?.trim() != "LUA_OUTPUT" {
        return None;
    }
    let text = cmd
        .descendants()
        .find(|n| n.has_tag_name("param") && n.children().any(|c| c.has_tag_name("name") && c.text() == Some("Text")))?
        .descendants()
        .find(|n| n.has_tag_name("static"))
        .and_then(|n| n.text())
        .unwrap_or_default()
        .to_string();
    Some((device, time, text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lua_output_event() {
        let raw = r#"<c4soap async="1" name="OnDataToUI" result="0"><param name="iddevice" type="ulong">483</param><param name="data" type="xml"><devicecommand><command>LUA_OUTPUT</command><params><param><name>Text</name><value type="XML"><static>[DLS] hi &amp; bye</static></value></param></params></devicecommand></param><param name="time" type="ulong">1795752893</param></c4soap>"#;
        assert_eq!(parse_lua_output(raw), Some((483, 1795752893, "[DLS] hi & bye".into())));
        let log = LuaLog::default();
        log.push(483, 1, "a".into());
        assert_eq!(log.lines(483, Some("a")).len(), 1);
        assert!(log.lines(483, Some("z")).is_empty());
    }

    #[test]
    fn keeps_last_500_per_device() {
        let log = LuaLog::default();
        for i in 0..600 {
            log.push(1, 0, format!("l{i}"));
        }
        let lines = log.lines(1, None);
        assert_eq!(lines.len(), 500);
        assert_eq!(lines[0].text, "l100");
        assert_eq!(log.mark(), 600);
    }
}
