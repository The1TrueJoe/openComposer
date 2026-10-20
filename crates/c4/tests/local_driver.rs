//! Reads driver metadata from files named in C4_DRIVER_FILES (colon-separated). Skipped
//! when unset: driver files are Control4's and aren't kept in this repo.
#[test]
fn reads_local_driver_files() {
    let Ok(list) = std::env::var("C4_DRIVER_FILES") else { return };
    for path in list.split(':') {
        let bytes = std::fs::read(path).unwrap();
        let name = std::path::Path::new(path).file_name().unwrap().to_string_lossy();
        let d = c4::drivers::LocalDriver::read(&name, &bytes).unwrap_or_else(|| panic!("can't read {path}"));
        println!("{d:?}");
        assert!(!d.name.is_empty());
    }
}
