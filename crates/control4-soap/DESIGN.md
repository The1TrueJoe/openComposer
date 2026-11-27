# control4-soap — API & migration design

Status: **protocol layer extracted and wired** (rebased on main `1750475`, with
PRs #6/#7). `soap.rs`, `xml.rs`, and `keys.rs` now live in this crate; c4
depends on it by path and re-exports it as `c4::soap` / `c4::xml`. The byte-exact
`calls_match_composer` lock passes with `Op::calls` in openComposer and
`Call::encode` here — the `Call` seam holds. `cargo test --workspace` green.

The **model and client layers did not move**: they are walled off by app-domain
coupling discovered during extraction (see §2.1). Moving them is a decoupling
*refactor*, not a mechanical move, and needs an owner decision — it is deferred,
not done. Nothing has been published (`publish = false`; see PUBLISH.md).

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

| Module | Status | Why |
|---|---|---|
| `soap.rs` | **MOVED** (verbatim) | the protocol; no app coupling |
| `xml.rs` | **MOVED** | `roxmltree` read helpers; `soap.rs`/`model.rs` use them |
| `keys.rs` | **MOVED** (private `mod keys`) | legacy-RSA TLS key provider; used only by `soap.rs` |
| `model.rs` | **BLOCKED** (§2.1) | `Project` embeds `crate::agents::{ScheduleEntry, AgentData}` |
| `dialect.rs` | **BLOCKED** (§2.1) | `client_ca_chains()` uses `crate::takeover::paths` |
| `director.rs` | **BLOCKED** (§2.1) | uses `crate::ops`, `crate::model`, `crate::dialect` |
| `drivers.rs` | deferred | clean leaf, but no current consumer needs it (YAGNI) |
| `c4p.rs` | deferred | clean leaf (`.c4p` backups), no current consumer needs it |
| `ops.rs` | **stays in openComposer** — see §4 | `Op` is app-domain authoring |

### 2.1 The coupling wall (why model/client did not move)

Extraction surfaced that the "client" layers are not separable without a
refactor the owner should sign off on:

- **`model::Project` depends on `agents.rs`.** `Project` has
  `schedules: BTreeMap<u32, Vec<agents::ScheduleEntry>>` and
  `agent_data: BTreeMap<u32, agents::AgentData>`, and its parser calls
  `agents::schedule_from_item` / `data_from_item` (fully-qualified, so a `use`
  grep misses them). `agents.rs` (~1200 lines of Announcements / Advanced
  Lighting / Wake-Sleep / notifications) is squarely app-domain and stays. So
  `model` cannot move without either dragging `agents` into the shared crate
  (wrong) or **decoupling `Project` from agent data** — e.g. store agent blobs
  as raw XML / a model-local type and parse them in openComposer. That touches
  `agent_ops`, `agent_views`, `diff`, and the approval flow: a real change.
- **`dialect::Dialect::client_ca_chains()` uses `crate::takeover::paths`.**
  `takeover` (controller CA/takeover) is app-domain and stays. Either move the
  three path constants to a neutral spot or invert the dependency.
- **`director.rs` sits on top of all three** (`ops`, `model`, `dialect`), so it
  can't move until they're resolved, plus the `apply`/`Op` split in §4.

None of this blocks the two external consumers: they need the **protocol**
(`soap`), which is done. Treat §2.1 as the agenda for a future `model`/`client`
extraction, each its own reviewed change.

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

**None today.** With only the protocol layer present, every dep is required, so
feature-gating would be dead config (YAGNI). The crate exposes `control4_soap::soap`
and `control4_soap::xml`; all three consumers that need the protocol take the
same thing. Introduce a `model`/`client` feature split only if and when those
layers are actually extracted (§2.1) — that is the point at which a consumer
could want the protocol without the heavier layers.

- **fake-navigator** and **navigator-sink-lib** use `control4_soap::soap`
  directly (hand-build `Call::new("GetItems")`, `SendToDevice`, `EnableEvents`;
  read `Reply`; subscribe to `Event`).
- **openComposer** depends on it by path and re-exports as `c4::soap`/`c4::xml`;
  its `Op` layer, `model`, and `Director` stay in-app (§2.1, §4).

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
pub const USER_AGENT: &str;           // "openComposer/<crate ver>" today — see §6.1

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

A future `model`/`client` extraction (§2.1) would add `Project`, `Director`,
`Catalog`, `Snapshot`, etc. — not present today.

## 6. Open decisions (for the owner)

1. **`USER_AGENT`** is `concat!("openComposer/", env!("CARGO_PKG_VERSION"))`.
   Moved verbatim, so it now reads `openComposer/<control4-soap version>` —
   identical to before tonight (both 0.1.0), and the only HTTP consumers
   (`broker`, `webui`, `state`) are openComposer's. **Deferred, not resolved:**
   for the other two consumers the product name no longer fits. When wiring them,
   default to `control4-soap/<ver>` and let the caller override (openComposer
   sets `openComposer/<ver>`). Do **not** impersonate Composer. `ponytail:` the
   override plumbing is skipped until a second consumer needs it — it threads a
   UA through `broker`/`webui`/`state` HTTP-client construction.
2. **License** — repo has no `LICENSE` and no `license` field anywhere. `cargo
   publish` requires one. Owner picks (e.g. `MIT OR Apache-2.0`) before publish.
3. **Crate vs. two crates** — one `control4-soap` (current) vs. a separate
   `control4-c4soap` for just the protocol. One crate is simpler and keeps a
   single "Used by" graph; revisit only if a `model`/`client` split lands and a
   consumer wants the protocol with a much lighter dep set.
4. **model/client extraction** — whether to pursue §2.1 at all, and how to
   decouple `Project` from `agents`. Not needed by the external consumers.

## 7. Migration — done vs. remaining

**Done** (this change):
1. `git mv soap.rs + xml.rs + keys.rs` into `crates/control4-soap/src/`
   (`keys` private; `xml`/`soap` public). Real deps in the crate `Cargo.toml`.
2. `c4` depends by path and re-exports `pub use control4_soap::{soap, xml};` so
   `c4::soap::…` / `c4::xml::…` and in-crate `crate::soap`/`crate::xml` are
   unchanged. `keys` dropped from c4 (moved).
3. `cargo test --workspace` green — `calls_match_composer` passes with
   `Call::encode` here and `Op::calls` in openComposer; soap's own tests run from
   the crate.

**Remaining** (future, owner-gated — each its own reviewed change):
4. Resolve §2.1 coupling for `model` (decouple `Project` from `agents`) and
   `dialect` (neutralize the `takeover::paths` reference), then move them.
5. Split `director.rs` per §4 (crate keeps connection + read verbs + generic
   `send_calls`; openComposer keeps `apply(op)` = predict → calls → send →
   verify) and move it; optionally `drivers.rs`/`c4p.rs` if a consumer needs them.
6. Resolve §6 decisions, set the license, follow PUBLISH.md to publish.

Each step stays green via the re-export shim, so openComposer never breaks.
