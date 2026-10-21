//! Read-only smoke test against real Directors.
//!
//!   C4_CERT=client.pem C4_KEY=client.key cargo run -p c4 --example live -- <host> [<other-host>]
//!
//! Connects, snapshots, reads the driver catalog, discovered devices and Zigbee nodes,
//! and with a second host prints the semantic diff between the two projects.

use c4::diff::{DiffOptions, diff};
use c4::director::ZigbeeQuery;
use c4::{Director, Identity};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let hosts: Vec<String> = std::env::args().skip(1).collect();
    let id = Identity::from_pem(&std::fs::read(std::env::var("C4_CERT")?)?, &std::fs::read(std::env::var("C4_KEY")?)?)?;
    let mut snaps = Vec::new();
    for host in &hosts {
        let t = std::time::Instant::now();
        let d = Director::connect(host, &id, None).await?;
        println!("== {host}: {} {} (verified dialect: {}) fp {}…", d.info.name, d.info.version, d.info.verified_version, &d.info.server_fingerprint[..16]);
        let s = d.snapshot().await?;
        let p = &s.project;
        println!("   snapshot: {} items, {} connections, {} network, {} variables, {} events with code  ({:?})",
            p.items.len(), p.bindings.len(), p.network_bindings.len(), p.variables.len(), p.programming.len(), t.elapsed());
        let cat = d.catalog().await?;
        let names = cat.names();
        println!("   catalog: {} driver definitions, {} connection names, room template: {}", cat.devices.len(), names.connections.len(), cat.room_template.is_some());
        let phys = d.physical_devices().await?;
        println!("   discovered: {} physical devices, e.g. {:?}", phys.len(), phys.first().map(|p| (&p.device_type, &p.address)));
        match d.zigbee(ZigbeeQuery::Nodes).await {
            Ok(v) => println!("   zigbee nodes: count={}", v["count"]),
            Err(e) => println!("   zigbee: {e}"),
        }
        snaps.push((host.clone(), s, names));
    }
    if let [(ha, a, _), (hb, b, names)] = snaps.as_slice() {
        let d = diff(&a.project, &b.project, names, DiffOptions::default());
        println!("\n== diff {ha} → {hb}: +{} -{} ~{}", d.summary.added, d.summary.removed, d.summary.changed);
        for c in d.changes.iter().take(25) {
            println!("   {}", serde_json::to_string(c)?.chars().take(220).collect::<String>());
        }
    }
    Ok(())
}
