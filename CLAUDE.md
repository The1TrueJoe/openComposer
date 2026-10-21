# openComposer — working notes

## Ground rules
- Commit on `main`; never force-push. No `Co-Authored-By` or other attribution trailers.
- **Never write to a real controller without the owner's explicit OK.** Develop and test
  writes against the Windows Virtual Director (`optiplex.local`, OS 3.3.3). The real EA-1
  (`192.168.1.172`) is read-only unless the owner says otherwise.
- Never commit certificates, keys, project data or Control4's code/logs. `poc/out*`,
  `*.pem`, `*.key`, `*.p12` are ignored; keep it that way.
- Before you say it works, run it, and say what you could not verify.

## Code
- Comments explain *why*. Module headers say what the module is for and what it is not.
- Errors are written for the person reading them: what happened and what to do.
- One registry per concept: tools are the typed functions in `app/src/actions.rs`, wrapped
  for MCP in `mcp.rs` and for the UI in `commands.rs`. Add a capability there, once.
- Every change to a Director is an `Op` (`crates/c4/src/ops.rs`) with `predict` (applies to a
  model, validates) and `calls` (what Composer would send). Writes go through
  `approvals::propose`; nothing else calls `Director::apply`.
- Version differences go in `crates/c4/src/dialect.rs`, not inline.
- `ponytail:` marks a deliberate shortcut, with its limit and the upgrade path.

## Checks
```bash
cargo test --workspace
npm --prefix ui run build
```
Live, read-only smoke test (needs the Composer cert):
```bash
C4_CERT=composer.pem C4_KEY=composer.key cargo run -p c4 --example live -- optiplex.local 192.168.1.172
```
Headless MCP server for end-to-end tests (auto-approves writes on the first host only —
point it at the Virtual Director):
```bash
OPENCOMPOSER_DATA=/tmp/oc C4_CERT=… C4_KEY=… cargo run -p opencomposer --example headless -- optiplex.local 192.168.1.172
```

## Known gaps
- Director accepts `AddBinding` for a connection id the item doesn't own and silently does
  nothing (combo drivers repeat their proxies' connection ids). `approvals::check_connections`
  refuses those up front; views list each connection under the proxy that owns it.
- Unsigned dev builds make macOS ask for keychain access after every rebuild. The headless
  harness keeps the identity in memory (`App::use_identity`) to avoid that.
- Driver files go through the controller's web API (`crates/c4/src/broker.rs`): a token
  from `POST /api/v1/localjwt` over mutual TLS, then `/api/v1/drivers/files/<name>`.
  Verified on the Virtual Director (its API is loopback-only; the harness reaches it with
  `ssh -L 18443:127.0.0.1:8443 admin@optiplex.local` and `VIRTUAL_WEB_API=127.0.0.1:18443`).
  Not yet used against the real EA-1. Backups still lack mm.db / identity.db / images
  (served over SMB by the controller).
- Programming: command lines can be added/removed (`add_code` / `remove_code`, checked
  against the device's events and the target's commands); a move is `remove_code` + `add_code`
  of the same line (verified on the Virtual Director). Conditionals, loops and variables
  aren't done. Proxy event names (e.g. a light's PUSH) come from Control4's
  built-in proxy definitions, which `GetItems` leaves unnamed. Z-Wave edits not captured.
- Codex agent path is unverified (no Codex on the dev machine).
- Identify (`add_network_binding`) after `add_device` is accepted by Director but didn't bind
  the WB-300 in a test; unverified until checked against a real discovered device.
- Never leave the headless harness running: it takes the MCP port from the real app.

## How things fit (added later)
- MCP auth: fixed bearer token, or OAuth sign-in (`oauth.rs`) approved in the app window.
- Driver web tabs (`webui.rs`): pages from driver packages with a shim that routes their
  `https://<apihost>` traffic through openComposer (controllers' certs are self-signed).
- Drivers come from, in order: the controller, the library (`library.rs`), other connected
  Directors, then `https://drivers.control4.com/<file>` (md5 from the search index checked).
- `.c4i` drivers are added with `c4i_name`, `.c4z` with `c4z_name`.
- Discovery: controllers answer SDDP `*` or their exact type only; only the primary runs a
  Director (`/api/v1/status` says `"director":"connected"`, secondaries `"disabled"`).
- A device with one proxy is named by the proxy (`Project::name_of` / `sole_proxy`): the device
  keeps the driver's generic name, the proxy holds the dealer's.
- New sites/buildings/floors/rooms copy an existing one's `<itemdata>` (`Catalog::template_for`)
  with a fresh `<tag>`.
- Agents' Composer editors are .NET plugins (`*.c4a.dll`) that talk `SendToDevice` with the
  agent's own commands (`crates/c4/src/agents.rs`). Scheduler is read/write; Advanced
  Lighting, Announcements, Wake/Sleep, Push/Email notification are read-only so far.
- The light colour wheel sends `SET_COLOR_TARGET` with light_v2's `LIGHT_COLOR_TARGET_*`
  params; not yet sent to a real light.
