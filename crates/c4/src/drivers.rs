//! The online driver database Composer searches, and reading local driver files.
//!
//! `https://drivers.control4.com/solr/drivers/browse` is a public Solr endpoint
//! (~24.7k drivers). Each document carries the driver file name, version, md5,
//! manufacturer/model, proxies, connection names/classes and — usefully — the SDDP
//! `searchType`, which is how a discovered device is matched to its driver.
//! The files themselves are served from the site root, `https://drivers.control4.com/<file>`,
//! and the index's `md5sum` lets a download be checked before it is installed.

use serde::{Deserialize, Serialize};

pub const SOLR: &str = "https://drivers.control4.com/solr/drivers/browse";
pub const FILES: &str = "https://drivers.control4.com";

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("the driver database has no file named {0}")]
    NotListed(String),
    #[error("couldn't download {name}: {source}")]
    Http { name: String, source: reqwest::Error },
    #[error("{name} downloaded but its checksum doesn't match the database ({got} ≠ {want}); not using it")]
    Checksum { name: String, got: String, want: String },
}

/// Download a driver file from the online database, checked against the index's md5.
pub async fn download(http: &reqwest::Client, filename: &str) -> Result<Vec<u8>, DownloadError> {
    let q = format!("filename:\"{}\"", filename.replace('"', ""));
    let v: serde_json::Value = http
        .get(SOLR)
        .query(&[("q", q.as_str()), ("wt", "json"), ("rows", "1")])
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|source| DownloadError::Http { name: filename.into(), source })?
        .json()
        .await
        .map_err(|source| DownloadError::Http { name: filename.into(), source })?;
    let doc = v["response"]["docs"]
        .as_array()
        .and_then(|d| d.iter().find(|d| s(d, "filename").eq_ignore_ascii_case(filename)))
        .ok_or_else(|| DownloadError::NotListed(filename.into()))?;
    let want = s(doc, "md5sum").to_ascii_lowercase();
    let bytes = http
        .get(format!("{FILES}/{}", url_path(filename)))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|source| DownloadError::Http { name: filename.into(), source })?
        .bytes()
        .await
        .map_err(|source| DownloadError::Http { name: filename.into(), source })?
        .to_vec();
    use md5::Digest;
    let got = hex::encode(md5::Md5::digest(&bytes));
    if !want.is_empty() && got != want {
        return Err(DownloadError::Checksum { name: filename.into(), got, want });
    }
    Ok(bytes)
}

fn url_path(name: &str) -> String {
    name.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

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

/// Metadata read from a driver file on disk: a `.c4i` is a `<devicedata>` document, a
/// `.c4z` is a zip with the same document in `driver.xml`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LocalDriver {
    pub filename: String,
    pub name: String,
    pub manufacturer: String,
    pub model: String,
    pub version: Option<i64>,
    pub creator: String,
    pub control_method: String,
    pub search_types: Vec<String>,
    pub proxies: Vec<String>,
    /// Network connection ids (type 4): what identifying the device binds.
    pub network_bindings: Vec<u32>,
    pub size: u64,
}

impl LocalDriver {
    pub fn read(filename: &str, bytes: &[u8]) -> Option<Self> {
        let xml = if filename.to_ascii_lowercase().ends_with(".c4z") {
            let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
            let mut f = z.by_name("driver.xml").ok()?;
            let mut s = String::new();
            std::io::Read::read_to_string(&mut f, &mut s).ok()?;
            s
        } else {
            String::from_utf8_lossy(bytes).into_owned()
        };
        let doc = roxmltree::Document::parse_with_options(&xml, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).ok()?;
        let root = doc.descendants().find(|n| n.has_tag_name("devicedata"))?;
        let t = |tag: &str| crate::xml::child_text(root, tag).unwrap_or_default().to_string();
        let texts = |tag: &str| -> Vec<String> {
            root.descendants().filter(|n| n.has_tag_name(tag)).filter_map(|n| n.text()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
        };
        let mut proxies = texts("proxy");
        proxies.dedup();
        let network_bindings = root
            .descendants()
            .filter(|n| n.has_tag_name("connection"))
            .filter(|c| crate::xml::child_u32(*c, "type") == Some(4))
            .filter_map(|c| crate::xml::child_u32(c, "id"))
            .collect();
        Some(Self {
            filename: filename.to_string(),
            name: t("name"),
            manufacturer: t("manufacturer"),
            model: t("model"),
            version: t("version").parse().ok(),
            creator: t("creator"),
            control_method: t("controlmethod"),
            search_types: texts("search_type"),
            proxies,
            network_bindings,
            size: bytes.len() as u64,
        })
    }
}
