# control4-sddp

SDDP — the Simple Device Discovery Protocol: HTTP-like text over UDP multicast
(`239.255.255.250:1902`). Devices announce themselves (`NOTIFY ALIVE SDDP/1.0`)
and answer searches (`SEARCH <type> SDDP/1.0`). Control4 and compatible devices
use it; this crate parses the datagrams and runs a discovery sweep.

No standard-library-only implementation existed in Rust before this; it was
extracted from [openComposer](https://github.com/The1TrueJoe/openComposer) so
other Control4 tooling can share one copy.

```rust
use std::time::Duration;

// Sweep for everything on the LAN for 3 seconds.
let found = control4_sddp::discover("*", Duration::from_secs(3)).await?;
for a in found {
    println!("{} {} ({})", a.address, a.host, a.device_type);
}

// Or parse a single datagram you already have.
let a = control4_sddp::parse(datagram).expect("an announcement, not a foreign search");
```

## What's here

- `Announcement` — a parsed `NOTIFY`/search-reply, with the common headers
  (`address`, `host`, `device_type`, `primary_proxy`, `proxies`, `manufacturer`,
  `model`, `driver`, `config_url`, `max_age`) lifted into fields and every raw
  header kept in `headers`.
- `parse(datagram) -> Option<Announcement>` — one datagram; `None` for searches
  from other clients.
- `discover(pattern, window) -> Vec<Announcement>` — send a `SEARCH` and collect
  replies for `window`, keyed by `Host` (most recent wins).
- `Announcement::is_controller()` — Control4 controller heuristic.
- `GROUP` / `PORT` constants.

Scope is deliberately just the protocol: no device-config, persistence, or app
wiring. `serde` derives are on `Announcement` so callers can store or ship it.

## License

See the repository.
