//! Composer's `.c4p` backup format.
//!
//! A stored (uncompressed) zip:
//!
//! ```text
//! project.xml            <currentstate>, exactly what Director's Upload returns
//! drivers/*.c4i|.c4z     every driver the project uses (built-in agents excluded)
//! mm.db, identity.db, images/, announcements/, wallpaper/   optional extras
//! ```
//!
//! with metadata in the zip comment, CR-separated, mirroring Composer's backup dialog:
//! `Project Name: X\r\rCreated: 7/25/2026 12:05:47 AM\rSource: ComposerPro 3.3.0\r…`.
//! Files written here load in Composer Pro 3.3 (checked by hand against both a real
//! EA-1 backup and a Virtual Director backup).

use std::collections::BTreeMap;
use std::io::{Read, Seek, Write};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;

/// The checkboxes in Composer's backup dialog, in the order the comment lists them.
pub const EXTRA_OPTIONS: [&str; 6] = [
    "Personal Information",
    "Announcements",
    "Cover Art",
    "Screen Saver Images",
    "Custom Wallpaper",
    "Identity Database",
];

#[derive(Debug, thiserror::Error)]
pub enum C4pError {
    #[error("not a .c4p (zip) file: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("backup has no project.xml")]
    NoProject,
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Meta {
    /// Ordered key/value pairs from the zip comment.
    pub fields: Vec<(String, String)>,
}

impl Meta {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub fn parse(comment: &str) -> Self {
        let fields = comment
            .split(['\r', '\n'])
            .filter_map(|l| l.split_once(": ").or_else(|| l.strip_suffix(':').map(|k| (k, ""))))
            .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
            .collect();
        Self { fields }
    }

    /// Composer's layout: blank lines after the name and after the author, and the
    /// option list, each line ended with CR.
    pub fn render(&self) -> String {
        let mut s = String::new();
        for (k, v) in &self.fields {
            s.push_str(&format!("{k}: {v}\r"));
            if k == "Project Name" || k == "Author" {
                s.push('\r');
            }
        }
        s.push_str("\r\r");
        s
    }
}

/// A backup opened for reading. Driver and extra files are read lazily.
pub struct Backup<R> {
    zip: zip::ZipArchive<R>,
    pub meta: Meta,
    pub project_xml: String,
}

impl<R: Read + Seek> Backup<R> {
    pub fn open(reader: R) -> Result<Self, C4pError> {
        let mut zip = zip::ZipArchive::new(reader)?;
        let meta = Meta::parse(&String::from_utf8_lossy(zip.comment()));
        let mut project_xml = String::new();
        zip.by_name("project.xml").map_err(|_| C4pError::NoProject)?.read_to_string(&mut project_xml)?;
        Ok(Self { zip, meta, project_xml })
    }

    pub fn drivers(&self) -> Vec<String> {
        self.zip
            .file_names()
            .filter_map(Result::ok)
            .filter_map(|n| n.strip_prefix("drivers/").map(String::from))
            .filter(|n| !n.is_empty())
            .collect()
    }

    pub fn entries(&self) -> Vec<String> {
        self.zip.file_names().filter_map(Result::ok).map(|n| n.into_owned()).collect()
    }

    pub fn read(&mut self, name: &str) -> Result<Vec<u8>, C4pError> {
        let mut out = Vec::new();
        self.zip.by_name(name)?.read_to_end(&mut out)?;
        Ok(out)
    }
}

/// Everything needed to write a backup.
pub struct NewBackup<'a> {
    pub project_name: &'a str,
    pub director_version: &'a str,
    pub created: &'a str,
    pub project_xml: &'a str,
    /// driver file name → bytes
    pub drivers: BTreeMap<String, Vec<u8>>,
    /// other entries (mm.db, images/…) → bytes; their presence sets the comment flags
    pub extras: BTreeMap<String, Vec<u8>>,
}

pub fn write<W: Write + Seek>(w: W, b: &NewBackup<'_>) -> Result<(), C4pError> {
    let mut z = zip::ZipWriter::new(w);
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    z.start_file("project.xml", stored)?;
    z.write_all(b.project_xml.as_bytes())?;
    z.add_directory("drivers/", stored)?;
    for (name, bytes) in &b.drivers {
        z.start_file(format!("drivers/{name}"), stored)?;
        z.write_all(bytes)?;
    }
    for (name, bytes) in &b.extras {
        z.start_file(name.as_str(), stored)?;
        z.write_all(bytes)?;
    }
    let has = |prefix: &str| b.extras.keys().any(|k| k.starts_with(prefix));
    let flags = [
        ("Personal Information", true),
        ("Announcements", has("announcements/")),
        ("Cover Art", has("images/")),
        ("Screen Saver Images", has("images/screensaver")),
        ("Custom Wallpaper", has("wallpaper/")),
        ("Identity Database", has("identity.db")),
    ];
    let mut meta = Meta {
        fields: vec![
            ("Project Name".into(), b.project_name.into()),
            ("Created".into(), b.created.into()),
            ("Source".into(), format!("openComposer {}", env!("CARGO_PKG_VERSION"))),
            ("Director".into(), b.director_version.into()),
            ("Author".into(), String::new()),
        ],
    };
    meta.fields.extend(flags.iter().map(|(k, v)| (k.to_string(), if *v { "True" } else { "False" }.to_string())));
    z.set_comment(meta.render())?;
    z.finish()?;
    Ok(())
}

/// Drivers every controller ships with; Composer leaves them out of backups.
pub fn is_builtin_driver(name: &str) -> bool {
    name.starts_with("control4_agent_") || name == "roomdevice.c4i" || !name.contains('.')
        || matches!(name, "Update Manager.c4i" | "Z-Wave.c4i" | "Z-Wave Scenes.c4i")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn comment_round_trips_composer_layout() {
        let raw = "Project Name: Camellia Dr\r\rCreated: 7/25/2026 12:05:47 AM\rSource: ComposerPro 3.3.0\rDirector: 3.3.0.628678-res\rAuthor: \r\rPersonal Information: True\rAnnouncements: True\r\r\r";
        let m = Meta::parse(raw);
        assert_eq!(m.get("Project Name"), Some("Camellia Dr"));
        assert_eq!(m.get("Author"), Some(""));
        assert_eq!(m.render(), raw);
    }

    #[test]
    fn writes_a_readable_backup() {
        let xml = include_str!("../tests/fixtures/sample-project.xml");
        let mut drivers = BTreeMap::new();
        drivers.insert("tv_samsung_ip.c4z".to_string(), b"zipbytes".to_vec());
        let mut buf = Cursor::new(Vec::new());
        write(&mut buf, &NewBackup {
            project_name: "Sample House",
            director_version: "3.3.3.660628-res",
            created: "1/1/2026 12:00:00 AM",
            project_xml: xml,
            drivers,
            extras: BTreeMap::new(),
        })
        .unwrap();
        buf.set_position(0);
        let b = Backup::open(buf).unwrap();
        assert_eq!(b.meta.get("Project Name"), Some("Sample House"));
        assert_eq!(b.drivers(), ["tv_samsung_ip.c4z"]);
        assert_eq!(b.project_xml, xml);
    }
}
