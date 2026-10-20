//! The driver library: driver files openComposer can install on a controller.
//!
//! The online database tells you which driver to use but doesn't hand out files, so files
//! come from here: ones you import, ones downloaded while taking backups, and — read in
//! place, never modified — Composer Pro's own driver folders when it is installed on this
//! computer. A controller's installed drivers (and other connected Directors') are the
//! other sources; `actions::add_driver` checks them all.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use c4::drivers::LocalDriver;
use serde::Serialize;

use crate::state::App;

#[derive(Clone, Debug, Serialize)]
pub struct LibraryDriver {
    #[serde(flatten)]
    pub meta: LocalDriver,
    pub path: String,
    /// `library` (openComposer's own folder) or `composer` (Composer Pro's folders).
    pub source: &'static str,
}

fn is_driver(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("c4z") || e.eq_ignore_ascii_case("c4i"))
}

pub fn dir(app: &App) -> PathBuf {
    let d = app.paths.data.join("drivers");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Composer Pro's driver folders, when it is installed here (Windows only).
fn composer_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        if let Some(docs) = directories::UserDirs::new().and_then(|u| u.document_dir().map(Path::to_path_buf)) {
            out.push(docs.join("Control4").join("Drivers"));
        }
        let shared = PathBuf::from(r"C:\Program Files (x86)\Control4\Shared");
        if let Ok(versions) = std::fs::read_dir(&shared) {
            out.extend(versions.flatten().map(|v| v.path().join("Drivers")));
        }
    }
    out.into_iter().filter(|d| d.is_dir()).collect()
}

fn scan(root: &Path, source: &'static str, out: &mut BTreeMap<String, LibraryDriver>) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if is_driver(&p) {
                let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
                // openComposer's own copy wins over Composer's; the first one found otherwise.
                if out.contains_key(&name) {
                    continue;
                }
                let Ok(bytes) = std::fs::read(&p) else { continue };
                if let Some(meta) = LocalDriver::read(&name, &bytes) {
                    out.insert(name, LibraryDriver { meta, path: p.display().to_string(), source });
                }
            }
        }
    }
}

pub fn list(app: &App) -> Vec<LibraryDriver> {
    let mut out = BTreeMap::new();
    scan(&dir(app), "library", &mut out);
    for d in composer_dirs() {
        scan(&d, "composer", &mut out);
    }
    out.into_values().collect()
}

pub fn find(app: &App, filename: &str) -> Option<(Vec<u8>, LibraryDriver)> {
    let hit = list(app).into_iter().find(|d| d.meta.filename.eq_ignore_ascii_case(filename))?;
    Some((std::fs::read(&hit.path).ok()?, hit))
}

/// Copy a driver file into the library. Refuses files that aren't readable drivers.
pub fn import(app: &App, path: &Path) -> anyhow::Result<LibraryDriver> {
    let name = path.file_name().ok_or_else(|| anyhow::anyhow!("no file name"))?.to_string_lossy().into_owned();
    if !is_driver(path) {
        anyhow::bail!("{name} isn't a driver file (.c4z or .c4i)");
    }
    let bytes = std::fs::read(path)?;
    store(app, &name, &bytes)
}

/// Keep a driver file (downloaded from a controller, or taken from a backup).
pub fn store(app: &App, filename: &str, bytes: &[u8]) -> anyhow::Result<LibraryDriver> {
    let meta = LocalDriver::read(filename, bytes).ok_or_else(|| anyhow::anyhow!("{filename} doesn't contain a readable driver definition"))?;
    let dest = dir(app).join(filename);
    std::fs::write(&dest, bytes)?;
    Ok(LibraryDriver { meta, path: dest.display().to_string(), source: "library" })
}
