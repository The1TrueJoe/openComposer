//! The online driver database Composer searches, and reading local driver files.
//!
//! `https://drivers.control4.com/solr/drivers/browse` is a public Solr endpoint
//! (~24.7k drivers). Each document carries the driver file name, version, md5,
//! manufacturer/model, proxies, connection names/classes and — usefully — the SDDP
//! `searchType`, which is how a discovered device is matched to its driver.
//! It does not hand out the driver files themselves.

use serde::{Deserialize, Serialize};

pub const SOLR: &str = "https://drivers.control4.com/solr/drivers/browse";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DriverDoc {
    pub filename: String,
    pub name: String,
    pub manufacturer: String,
    pub model: String,
    pub version: Option<i64>,
    pub creator: String,
    pub control_method: String,
    pub certified: bool,
    pub primary_proxy: String,
    pub proxies: Vec<String>,
    pub search_types: Vec<String>,
    pub connection_names: Vec<String>,
    pub connection_classes: Vec<String>,
    pub date_modified: String,
    pub md5: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SearchResult {
    pub total: u64,
    pub drivers: Vec<DriverDoc>,
}

fn s(v: &serde_json::Value, k: &str) -> String {
    match &v[k] {
        serde_json::Value::String(x) => x.clone(),
        serde_json::Value::Array(a) => a.first().and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        _ => String::new(),
    }
}

fn list(v: &serde_json::Value, k: &str) -> Vec<String> {
    match &v[k] {
        serde_json::Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        serde_json::Value::String(x) => vec![x.clone()],
        _ => vec![],
    }
}

impl DriverDoc {
    fn from_solr(d: &serde_json::Value) -> Self {
        Self {
            filename: s(d, "filename"),
            name: s(d, "name"),
            manufacturer: s(d, "manufacturer"),
            model: s(d, "model"),
            version: d["version"].as_i64(),
            creator: s(d, "creator"),
            control_method: s(d, "controlMethod"),
            certified: d["certified"].as_bool().unwrap_or(false),
            primary_proxy: s(d, "primaryProxy"),
            proxies: list(d, "proxy"),
            search_types: list(d, "searchType"),
            connection_names: list(d, "connectionNames"),
            connection_classes: list(d, "connectionClasses"),
            date_modified: s(d, "dateLastModified"),
            md5: s(d, "md5sum"),
        }
    }
}

/// Free-text search, optionally restricted to an SDDP search type.
pub async fn search(http: &reqwest::Client, text: &str, search_type: Option<&str>, rows: u32) -> reqwest::Result<SearchResult> {
    let mut q = if text.trim().is_empty() { "*:*".to_string() } else { text.trim().to_string() };
    if let Some(t) = search_type {
        q = format!("searchType:\"{}\"", t.replace('"', ""));
    }
    let v: serde_json::Value = http
        .get(SOLR)
        .query(&[("q", q.as_str()), ("wt", "json"), ("rows", &rows.to_string())])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(SearchResult {
        total: v["response"]["numFound"].as_u64().unwrap_or(0),
        drivers: v["response"]["docs"].as_array().map(|a| a.iter().map(DriverDoc::from_solr).collect()).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_solr_fields() {
        let v = serde_json::json!({
            "filename": "receiver_Denon_DenonHomeAmp_ip.c4i", "name": "DenonHomeAmp",
            "manufacturer": "Denon", "model": "DenonHomeAmp [IP]", "version": 105,
            "searchType": ["Denon:DenonHomeAmp"], "proxy": ["receiver", "media_player"],
            "connectionClasses": ["RECEIVER", "HDMI"], "controlMethod": "ip"
        });
        let d = DriverDoc::from_solr(&v);
        assert_eq!(d.filename, "receiver_Denon_DenonHomeAmp_ip.c4i");
        assert_eq!(d.search_types, ["Denon:DenonHomeAmp"]);
        assert_eq!(d.version, Some(105));
    }
}
