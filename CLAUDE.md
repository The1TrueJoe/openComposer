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
- Z-Wave and programming edits haven't been captured from Composer yet.
- Codex agent path is unverified (no Codex on the dev machine).
