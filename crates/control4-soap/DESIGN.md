# control4-soap — API & migration design

Status: **scaffold**. Code moves after openComposer PRs #6 and #7 merge (both
touch `crates/c4/src/ops.rs`, which this extraction also edits). This document
is the contract to build against meanwhile.

## 1. Why this crate

Three consumers hand-roll or would otherwise submodule the same c4soap client:

- **control4-navigator-sink-lib** — receives/mirrors Navigator traffic.
- **control4-fake-navigator** — pretends to *be* a Navigator/device.
- **openComposer** — the full configurator.

The shared asset is the **cert-pinned XML-over-TLS protocol** in
`crates/c4/src/soap.rs`: `Connection`, the typed `Call` builder, `Value`,
`Reply`, `Event`, `Identity`, and the TLS/pinning setup. It is small, already
test-locked, and identical for all three.

### Hard constraint — keep the byte-exact encoder

`Call::encode` (in `soap.rs`) and openComposer's `Op::calls()` (in `ops.rs`)
together reproduce Composer's exact wire bytes, locked by the
`calls_match_composer` test in `ops.rs`. **Do not rewrite either onto
`quick-xml::Writer` or any generic serializer.** The parse side already uses
`roxmltree` (maintained), so the "use a maintained XML crate" goal is met on the
read side without touching the write side. `Call::encode` moves into this crate
*verbatim*; `Op::calls()` stays in openComposer (see §4) and keeps its test.

## 2. Layer map — what moves, what stays

From `crates/c4/`:

| Module | Destination | Layer |
|---|---|---|
| `soap.rs` | **move** (verbatim) | `protocol` |
| `xml.rs` | **move** (escape/helpers; `soap.rs` uses `xml::escape`) | `protocol` |
| `model.rs` | **move** (`Project`, `Item`, `ItemKind`, `Binding`, `NetworkBinding`, `Variable`, `CodeItem`, `Names`, `event_key`) | `model` |
| `dialect.rs` | **move** (OS-version wire differences) | `model` |
| `keys.rs` | **move** (wire key helpers) | `model` |
| `director.rs` | **move** read verbs + `Catalog`/`Snapshot`/`DeviceInfo`; see §4 for `apply` | `client` |
| `drivers.rs` | **move** (driver catalog types) | `client` |
| `c4p.rs` | **move** (`.c4p` backup read/write) | `client` |
| `ops.rs` | **partial** — see §4 | `ops` (gated) |

Stays in openComposer (app-domain; never in the crate):

- `agents.rs`, `agent_ops.rs` — agent command encoding / agent-editor ops.
- `program.rs` — programming (If/While/Delay/…) authoring.
- `diff.rs` — semantic diff for approval cards.
- `sidecar.rs`, `takeover.rs`, `broker.rs`, `webui.rs`, `zigbee.rs` — sidecar
  detection, controller takeover/CA, web-API driver-file broker, driver web
  tabs, Zigbee config. App/deployment concerns, not the protocol.
- `approvals`, `mcp.rs`, `actions.rs`, `commands.rs`, `oauth.rs`, `certs.rs`,
  `library.rs` — MCP/UI/auth wiring.
- **SDDP** → openComposer now depends on the owner's existing shared `sddp`
  crate (`github.com/The1TrueJoe/sddp`, also used by control4-audio-client and
  openhc-control4); `crates/c4/src/sddp.rs` is just a thin projection +
  controller heuristic on top. Not part of this crate.

## 3. Cargo features

Layered so the two external consumers can take just the protocol without
openComposer's project model or authoring machinery:

```toml
[features]
default = ["protocol"]
protocol = []                 # soap.rs: Connection/Call/Value/Reply/Event/Identity/tls
model    = ["protocol", ...]  # typed Project/Item wire types (+ serde, roxmltree)
client   = ["model"]          # director.rs read verbs, drivers catalog, c4p backups
ops      = ["client"]         # Op::calls builder — GATED on #6/#7, may land later or stay in-app
```

- **fake-navigator** and **navigator-sink-lib** are expected to need only
  `protocol` (hand-build `Call::new("GetItems")`, `SendToDevice`, `EnableEvents`;
  read `Reply`; subscribe to `Event`), optionally `model` to parse snapshots.
- **openComposer** enables `client` (and keeps its own `Op` layer in-app, §4).

## 4. The `ops.rs` seam (the reason for the gate)

`Op` (in `ops.rs`) is **openComposer's config-authoring taxonomy**, not a shared
type. Two couplings prove it:

1. `Op` has agent variants (`AddLightingScene`, `AddAnnouncement`, …) that
   dispatch into `crate::agent_ops`, and Zigbee ops that build calls via
   `crate::zigbee` — both of which **stay in openComposer** (§2).
2. `Op::predict` mutates a `Project` to validate and feed openComposer's
   approval diff — an app concern.

So **`Op`, `predict`, `calls`, and `Director::apply(&Op, …)` stay in
openComposer.** The crate exposes the *mechanism* they ride on, not the taxonomy:

- `Connection::call(Call) -> Reply`, `call_raw`, `send_async`, `events()`.
- `Director` read verbs: `snapshot`, `catalog`, `physical_devices`,
  `read(method, params)`, `agent_read`. (All generic; no `Op`.)
- openComposer keeps `Op::calls() -> Vec<Call>` and drives the crate's
  `Connection`/`Director` with the resulting `Call`s. The byte-exact test
  (`calls_match_composer`) stays on the openComposer side with `Op`.

Net: the crate boundary falls exactly on `Call`. The write-side encoder is split
across it — `Call::encode` in the crate, `Op::calls` in the app — and **neither
is rewritten**. The `ops` feature is a placeholder for a *future* decision to
ship a small, agent-free subset of op-building helpers; it is **not** required by
any of the three consumers and is explicitly deferred.

### `Director::apply` disposition

Today `director.rs::apply(&self, op: &Op, room_template) -> Applied` lives in the
client layer and depends on `Op`. On extraction, split it:

- Crate `Director` keeps the connection + read verbs + a generic
  `send_calls(&[Call]) -> Vec<Reply>` (the raw apply mechanism).
- openComposer keeps `apply(op)`: `op.predict` → `op.calls()` →
  `director.send_calls(...)` → snapshot re-read/verify. This is the approval
  flow and is app-domain.

## 5. Public API sketch (root, `protocol` feature)

Re-exported verbatim from the moved `soap.rs` — signatures already exist today:

```rust
pub const TLS_PORT: u16;              // 5021
pub const USER_AGENT: &str;           // see §6 — becomes caller-overridable

pub struct Identity { /* client cert + key */ }
impl Identity { pub fn from_pem(cert_pem: &[u8], key_pem: &[u8]) -> Result<Self>; pub fn fingerprint(&self) -> String; }

pub enum Value { Num(i64), Str(String), Bool(bool), Xml(String) }

pub struct Call;                       // the byte-exact typed builder — KEPT AS-IS
impl Call {
    pub fn new(method: impl Into<String>) -> Self;
    pub fn num(self, name: &str, v: impl Into<i64>) -> Self;
    pub fn str(self, name: &str, v: impl Into<String>) -> Self;
    pub fn bool(self, name: &str, v: bool) -> Self;
    pub fn xml(self, name: &str, v: impl Into<String>) -> Self;
    pub fn timeout(self, t: Duration) -> Self;
    pub fn encode(&self, is_async: bool) -> String;   // exact wire bytes
}

pub struct Reply;
impl Reply { pub fn doc(&self) -> Result<roxmltree::Document<'_>>; pub fn body(&self) -> &str; pub fn check(self) -> Result<Self>; }

pub struct Event;
impl Event { pub fn param(&self, name: &str) -> Option<String>; }

pub struct Connection;
impl Connection {
    pub async fn connect(host: &str, port: u16, identity: &Identity, pin: Option<&str>) -> Result<Self>;
    pub fn events(&self) -> tokio::sync::broadcast::Receiver<Event>;
    pub async fn call(&self, call: Call) -> Result<Reply>;
    pub async fn call_raw(&self, call: &Call) -> Result<Reply>;
    pub async fn send_async(&self, call: &Call) -> Result<()>;
    pub async fn enable_events(&self) -> Result<()>;
    pub async fn request_event(&self, call: &Call, event: &str, timeout: Duration) -> Result<Event>;
    pub async fn close(&self);
}

pub fn tls_config(identity: &Identity, pin: Option<&str>) -> Result<(rustls::ClientConfig, SeenCert)>;
pub fn split_addr(addr: &str, default_port: u16) -> (String, u16);
```

`client` feature adds `Director`, `Catalog`, `Snapshot`, `DeviceInfo`,
`PhysicalDevice`, `ZigbeeQuery`, etc. from `director.rs` (read verbs only).

## 6. Open decisions (need the owner, flagged for morning)

1. **`USER_AGENT`** is `concat!("openComposer/", env!("CARGO_PKG_VERSION"))`. In a
   shared crate the product name no longer fits. Keep transport-parity honesty
   (CLAUDE.md): default to `control4-soap/<ver>` and let the caller override it
   (openComposer sets `openComposer/<ver>`). Do **not** impersonate Composer.
2. **License** — repo has no `LICENSE` and no `license` field anywhere. `cargo
   publish` requires one. Owner picks (e.g. `MIT OR Apache-2.0`) before publish.
3. **Crate vs. two crates** — one `control4-soap` with features (recommended,
   per brief) vs. splitting `protocol` into its own `control4-c4soap`. Features
   are simpler and keep one "Used by" graph; stay with one crate unless a
   consumer needs `protocol` with a wildly lighter dep set.
4. **`ops` feature** — ship any op-building helpers at all, or leave all op
   authoring in openComposer? Default: leave it out of v0.1.0 (§4).

## 7. Migration steps (execute post-#6/#7)

1. `git mv` `soap.rs` + `xml.rs` into `crates/control4-soap/src/`; split into
   `protocol` module; wire `[features] protocol`. Uncomment core deps.
2. Point `c4` at `control4-soap` by path; re-export (`pub use control4_soap as
   soap;`) so `c4::soap::…` call sites are unchanged — same trick as
   `control4-sddp`.
3. `cargo test --workspace` — `calls_match_composer` and all soap tests green
   from their new home (or from openComposer for `Op::calls`).
4. Move `model.rs`/`dialect.rs`/`keys.rs` behind `model`; repeat the re-export
   wiring and re-run tests.
5. Move `director.rs` (read verbs) + `drivers.rs` + `c4p.rs` behind `client`;
   split `apply` per §4; re-run tests.
6. Resolve §6 decisions, fill publish metadata, follow PUBLISH.md.

Each step is its own commit and leaves the workspace green via the re-export
shim, so openComposer never sees a breaking change.
