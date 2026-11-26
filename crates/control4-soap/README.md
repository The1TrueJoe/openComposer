# control4-soap

The **c4soap** wire protocol — a Control4 Director's own protocol: one
NUL-terminated XML document per message over cert-pinned mutual TLS on port
5021. This is the client side of it, shared by [openComposer](https://github.com/The1TrueJoe/openComposer)
and the Control4 navigator tools.

```rust
use std::time::Duration;
use control4_soap::soap::{Connection, Identity, Call, TLS_PORT};

# async fn demo(identity: &Identity) -> Result<(), Box<dyn std::error::Error>> {
let conn = Connection::connect("192.168.1.172", TLS_PORT, identity, None).await?;
let items = conn.call(Call::new("GetItems").timeout(Duration::from_secs(180))).await?;
println!("{}", items.body());
# Ok(())
# }
```

## What's here

- `soap` — `Connection`, the typed byte-exact `Call` builder, `Value`, `Reply`,
  `Event`, `Identity`, and the TLS/pinning setup (`tls_config`, `split_addr`).
  The `Call` encoder reproduces Composer's exact wire bytes and is **not** a
  generic serializer — it's test-locked.
- `xml` — small `roxmltree` read helpers used by the protocol.

Only the protocol layer lives here. openComposer's project model, Director
client, and op-authoring stay in openComposer: they're coupled to app-domain
code (agents, takeover, ops) and aren't part of the shared wire protocol. See
[`DESIGN.md`](DESIGN.md) for the boundary and the (deferred) model/client plan.

## License

See the repository. `publish = false` is set until the owner picks a license and
publishes (see `PUBLISH.md` in the openComposer repo).
