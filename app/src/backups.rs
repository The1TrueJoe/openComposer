//! The backup library: `.c4p` files in the app's data directory.
//!
//! Restore points taken before each approved change land here too, so every change
//! made through openComposer can be compared against, or rolled back to, the project
//! as it was.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use c4::c4p::{self, Backup, NewBackup};
use c4::director::Snapshot;
use c4::Project;
use serde::Serialize;

use crate::config::SavedDirector;
use crate::state::App;

#[derive(Clone, Debug, Serialize)]
pub struct BackupInfo {
    pub file: String,
    pub path: String,
    pub project: String,
    pub created: String,
    pub source: String,
    pub director: String,
    pub size: u64,
    pub drivers: usize,
}

pub fn list(app: &App) -> Vec<BackupInfo> {
    let mut out: Vec<BackupInfo> = std::fs::read_dir(app.paths.backups())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("c4p")))
        .filter_map(|e| info(&e.path()).ok())
        .collect();
    out.sort_by(|a, b| b.file.cmp(&a.file));
    out
}

pub fn info(path: &Path) -> anyhow::Result<BackupInfo> {
    let f = std::fs::File::open(path)?;
    let size = f.metadata()?.len();
    let b = Backup::open(f)?;
    Ok(BackupInfo {
        file: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.display().to_string(),
        project: b.meta.get("Project Name").unwrap_or_default().into(),
        created: b.meta.get("Created").unwrap_or_default().into(),
        source: b.meta.get("Source").unwrap_or_default().into(),
        director: b.meta.get("Director").unwrap_or_default().into(),
        size,
        drivers: b.drivers().len(),
    })
}

/// Resolve a backup by file name (in the library) or by absolute path.
pub fn resolve(app: &App, which: &str) -> anyhow::Result<PathBuf> {
    let p = PathBuf::from(which);
    if p.is_absolute() && p.exists() {
        return Ok(p);
    }
    let in_lib = app.paths.backups().join(which);
    if in_lib.exists() {
        return Ok(in_lib);
    }
    anyhow::bail!("no backup named “{which}” (list_backups shows the library)")
}

pub fn read_project(path: &Path) -> anyhow::Result<(String, Project)> {
    let b = Backup::open(std::fs::File::open(path)?)?;
    let p = Project::parse(&b.project_xml)?;
    Ok((b.project_xml, p))
}

/// Restore points: the project only (they are taken before every approved change, so
/// they stay fast; driver files don't change when a project does).
pub fn save_snapshot(app: &App, saved: &SavedDirector, version: &str, snap: &Snapshot, label: &str) -> anyhow::Result<PathBuf> {
    save(app, saved, version, snap, label, BTreeMap::new())
}

pub fn save(
    app: &App,
    saved: &SavedDirector,
    version: &str,
    snap: &Snapshot,
    label: &str,
    drivers: BTreeMap<String, Vec<u8>>,
) -> anyhow::Result<PathBuf> {
    let now = chrono::Local::now();
    let safe = |s: &str| s.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect::<String>();
    let file = format!(
        "{} {} {}.c4p",
        safe(&snap.project.name),
        now.format("%Y-%m-%d %H%M%S"),
        safe(label)
    );
    let path = app.paths.backups().join(file);
    let created = now.format("%-m/%-d/%Y %-I:%M:%S %p").to_string();
    let mut f = std::fs::File::create(&path)?;
    c4p::write(
        &mut f,
        &NewBackup {
            project_name: &snap.project.name,
            director_version: &format!("{version} ({})", saved.name),
            created: &created,
            project_xml: &snap.xml,
            drivers,
            extras: BTreeMap::new(),
        },
    )?;
    app.emit("backups", list(app));
    Ok(path)
}
