//! Child processes that cannot outlive the app.
//!
//! The only children openComposer starts are the user's `claude` / `codex` CLIs for
//! the in-app agent. Each is killed when its handle drops; on Windows they also sit in
//! a kill-on-close job object, so even a crash of openComposer takes them down. On
//! macOS/Linux the agent reads its prompts from our stdin pipe, which closes when we
//! exit, and it stops at EOF.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::{Child, Command};

pub fn spawn(program: &Path, args: &[String], cwd: &Path) -> std::io::Result<Child> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .env("PATH", search_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn()?;
    #[cfg(windows)]
    job::adopt(&child);
    Ok(child)
}

/// GUI apps on macOS start with a bare PATH; add the places CLIs are installed.
pub fn search_path() -> String {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = directories::BaseDirs::new().map(|b| b.home_dir().to_path_buf()) {
        dirs.extend([home.join(".local/bin"), home.join(".claude/local"), home.join(".npm-global/bin"), home.join(".cargo/bin")]);
        #[cfg(windows)]
        dirs.extend([home.join("AppData/Roaming/npm"), home.join(".local/bin")]);
    }
    #[cfg(unix)]
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    dirs.dedup();
    std::env::join_paths(dirs).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Find an executable on [`search_path`].
pub fn which(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    std::env::split_paths(&search_path()).find_map(|d| {
        exts.iter().map(|e| d.join(format!("{name}{e}"))).find(|p| p.is_file())
    })
}

#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::*;

    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    fn job() -> Option<&'static Job> {
        static JOB: OnceLock<Option<Job>> = OnceLock::new();
        JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            Some(Job(h))
        })
        .as_ref()
    }

    pub fn adopt(child: &tokio::process::Child) {
        if let (Some(j), Some(h)) = (job(), child.raw_handle()) {
            unsafe {
                AssignProcessToJobObject(j.0, h as HANDLE);
            }
        }
    }
}
