//! Certificate import from loose files. Uses a client cert pair from C4_CERT_DIR
//! (client.pem + client.key) when set; skipped otherwise — keys aren't kept in the repo.
use std::path::PathBuf;

#[test]
fn lone_pem_finds_its_key_and_pairs_load() {
    let Ok(dir) = std::env::var("C4_CERT_DIR") else { return };
    let dir = PathBuf::from(dir);
    let pem = dir.join("client.pem");
    // Just the certificate: the sibling client.key is picked up.
    let id = opencomposer::certs::from_files(&[pem.clone()], None).expect("pem + sibling key");
    assert!(id.key_pem.contains("PRIVATE KEY"));
    // Both files, in either order.
    opencomposer::certs::from_files(&[dir.join("client.key"), pem.clone()], None).expect("both files");
    // A key alone is not enough.
    // (StoredIdentity has no Debug on purpose — it holds the key — so match, don't unwrap_err.)
    let Err(e) = opencomposer::certs::from_files(&[dir.join("client.key")], None) else { panic!("a key alone was accepted") };
    assert!(e.to_string().contains("no certificate"), "{e}");
}
