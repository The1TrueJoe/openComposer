//! Updating a driver that devices already use.
//!
//! Putting a file on the controller (`broker::install_driver`) doesn't make running devices
//! pick it up. The controller's Driver Update agent does that in two steps: `EVALUATE_DRIVER`
//! (answers whether the new file may replace the old one, and whether that needs a Director
//! restart) and `UPDATE_DRIVERS` (replaces it, answered later as events). This module builds
//! those commands and reads the answer. It does not send anything; `Director` does.

use std::io::Read;

use crate::model::Project;
use crate::soap::Call;
use crate::xml::escape;

/// The Driver Update agent's usual item id; [`find_agent`] looks it up by driver file first.
pub const FALLBACK_AGENT: u32 = 100124;
const AGENT_DRIVER: &str = "control4_agent_driverupdate.c4i";

/// The Driver Update agent in this project (matched by its driver file), else the usual id.
pub fn find_agent(p: &Project) -> u32 {
    p.items
        .values()
        .find(|i| i.driver.as_deref().is_some_and(|d| d.eq_ignore_ascii_case(AGENT_DRIVER)))
        .map(|i| i.id)
        .unwrap_or(FALLBACK_AGENT)
}

/// `driver.xml` from inside a `.c4z` (a zip). `None` for a `.c4i` or a package without one.
pub fn driver_xml(c4z: &[u8]) -> Option<String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(c4z)).ok()?;
    let name = z.file_names().filter_map(|n| n.ok()).find(|n| n.eq_ignore_ascii_case("driver.xml"))?.to_string();
    let mut f = z.by_name(&name).ok()?;
    let mut raw = Vec::new();
    f.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    Some(text.trim_start_matches('\u{feff}').to_string())
}

/// The `<driver_files>` list `EVALUATE_DRIVER` takes (one driver, replacing a file of the same name).
pub fn evaluate_list(filename: &str, new_xml: &str) -> String {
    format!(
        "<drivers><driver><cur_driver_file>{n}</cur_driver_file><new_driver_file>{n}</new_driver_file><new_driver_xml>{x}</new_driver_xml></driver></drivers>",
        n = escape(filename),
        x = escape(new_xml)
    )
}

/// `SendToDevice` (answered at once) asking the agent whether `filename` may be replaced.
pub fn evaluate_call(agent: u32, filename: &str, new_xml: &str) -> Call {
    let data = crate::agents::device_command("EVALUATE_DRIVER", &[("cur_driver_files", "STRING", &evaluate_list(filename, new_xml))]);
    Call::new("SendToDevice").num("iddevice", agent).xml("data", data)
}

/// `SendToDeviceAsync` that replaces the driver; progress comes back as events.
pub fn update_call(agent: u32, filename: &str, director_restart: bool) -> Call {
    let files = format!(
        "<driver_files><driver><driver_name>{}</driver_name><director_restart>{}</director_restart></driver></driver_files>",
        escape(filename),
        director_restart
    );
    let data = crate::agents::device_command("UPDATE_DRIVERS", &[("driver_files", "STRING", &files), ("restart_director", "STRING", "False")]);
    Call::new("SendToDeviceAsync").num("iddevice", agent).xml("data", data)
}

/// What the agent said about replacing one driver file.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Evaluation {
    pub driver_name: String,
    pub update_code: String,
    pub can_update_driver: bool,
    pub prompt_overwrite: bool,
    pub prompt_overwrite_message: String,
    pub requires_restart: bool,
}

fn truthy(s: &str) -> bool {
    s.trim().eq_ignore_ascii_case("true") || s.trim() == "1"
}

/// Parse the agent's reply to `EVALUATE_DRIVER`. The `<drivers>` document may come back as
/// markup or as escaped text inside another element; both are handled.
pub fn parse_evaluation(body: &str) -> Option<Evaluation> {
    fn from_doc(xml: &str) -> Option<Evaluation> {
        let doc = roxmltree::Document::parse(xml).ok()?;
        let d = doc.descendants().find(|n| n.has_tag_name("driver") && n.children().any(|c| c.has_tag_name("update_code")))?;
        let t = |name: &str| d.children().find(|c| c.has_tag_name(name)).and_then(|c| c.text()).unwrap_or_default().trim().to_string();
        Some(Evaluation {
            driver_name: t("driver_name"),
            update_code: t("update_code"),
            can_update_driver: truthy(&t("can_update_driver")),
            prompt_overwrite: truthy(&t("prompt_overwrite")),
            prompt_overwrite_message: t("prompt_overwrite_message"),
            requires_restart: truthy(&t("requires_restart")),
        })
    }
    if let Some(e) = from_doc(body) {
        return Some(e);
    }
    // Escaped once inside some wrapper element: unwrap the text and parse that.
    let wrapped = roxmltree::Document::parse(body).ok()?;
    let text: String = wrapped.root_element().descendants().filter(|n| n.is_text()).filter_map(|n| n.text()).collect();
    from_doc(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluate_envelope_escapes_once_inside_static() {
        let c = evaluate_call(100124, "a.c4z", "<driver name=\"a\"/>");
        let xml = c.encode(false);
        assert!(xml.contains(r#"<param name="iddevice" type="number">100124</param>"#), "{xml}");
        assert!(xml.contains("<command>EVALUATE_DRIVER</command>"), "{xml}");
        // list is escaped once by escape(new_xml) and once more as the <static> text
        assert!(xml.contains("&lt;drivers&gt;&lt;driver&gt;&lt;cur_driver_file&gt;a.c4z"), "{xml}");
        assert!(roxmltree::Document::parse(&xml).is_ok(), "{xml}");
    }

    #[test]
    fn update_envelope_is_async() {
        let xml = update_call(100124, "a.c4z", true).encode(true);
        assert!(xml.contains(r#"name="SendToDeviceAsync""#) && xml.contains(r#"async="True""#), "{xml}");
        assert!(xml.contains("director_restart&gt;true&lt;"), "{xml}");
        assert!(roxmltree::Document::parse(&xml).is_ok(), "{xml}");
    }

    #[test]
    fn evaluation_reply() {
        let body = "<drivers><driver><driver_name>x.c4z</driver_name><update_code>SUCCESS</update_code><can_update_driver>True</can_update_driver><prompt_overwrite>True</prompt_overwrite><prompt_overwrite_message>Versions are equal.</prompt_overwrite_message><requires_restart>False</requires_restart></driver></drivers>";
        let e = parse_evaluation(body).unwrap();
        assert!(e.can_update_driver && e.prompt_overwrite && !e.requires_restart);
        assert_eq!(e.prompt_overwrite_message, "Versions are equal.");
        let wrapped = format!("<r>{}</r>", escape(body));
        assert_eq!(parse_evaluation(&wrapped).unwrap(), e);
    }
}
