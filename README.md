# openComposer

A desktop app for Control4 systems that does what Composer Pro does — browse the project,
drivers, connections, network/SDDP, Zigbee and programming; back up and load projects — and
exposes all of it to AI assistants over MCP, with an in-app agent chat on top.

Nothing changes on a controller without a person approving a **project diff** first.

## How it talks to Control4

- **Director protocol**: c4soap over TLS on port 5021 with a client certificate, the same
  protocol Composer Pro uses. Works with Composer's own `composer.pem`/`composer.key`
  (1024-bit RSA keys are supported even though modern TLS stacks reject them).
- **Project snapshots**: Director's `Upload` returns the same `project.xml` a `.c4p` backup
  contains, so live systems, backups and predicted changes share one model and one diff.
- **Backups**: `.c4p` files in Composer's format (Composer Pro opens them).
- **Discovery**: SDDP multicast; the public driver database is searched by SDDP type.
- **Versions**: verified on OS 3.3.0 and 3.3.3 (real EA-1 and the Windows Virtual Director).
  Everything version-specific lives in `crates/c4/src/dialect.rs`.

## Safety model

| | |
|---|---|
| Reads | run freely |
| Writes | every change is applied to a copy of the project first; the predicted semantic diff is shown as an approval card; nothing runs until someone approves |
| After approval | the current project is saved as a restore point, the change is applied, the project is read back and the real diff is checked against the prediction |
| Per Director | each Director can be set **read-only**, which refuses all writes |
| Credentials | properties that look like passwords/tokens are masked everywhere, including MCP results |
| Controller identity | the controller's TLS certificate is pinned on first connect |

## Using it with Claude Code or Codex

The app runs an MCP server (Settings → MCP shows the URL and token).

```bash
claude mcp add --transport http openComposer http://<this-computer>:7710/mcp --header "Authorization: Bearer <token>"
```

Codex (`~/.codex/config.toml`), via the stdio bridge built into the app binary:

```toml
[mcp_servers.openComposer]
command = "/Applications/openComposer.app/Contents/MacOS/openComposer"
args = ["--mcp-stdio"]
```

The in-app **Agent** tab runs your installed `claude` (or `codex`) CLI with openComposer's
tools only — no shell, no file access, none of your other MCP servers — using whatever
account that CLI is signed in with.

## Processes

One process, `openComposer`. The only children are the agent CLIs you start from the Agent
tab; they are killed with the app (a kill-on-close job object on Windows; stdin EOF and
process-group kill on macOS/Linux). The OS web view's own helper processes are the
platform's (WebView2 on Windows, WebKit on macOS).

## Building

```bash
npm ci --prefix ui
npx @tauri-apps/cli@2.12.3 dev --config app/tauri.conf.json
```

Release installers (unsigned macOS universal `.dmg` and Windows NSIS `.exe`) are built by
the `release` workflow: run it from the Actions tab or push a `v*` tag.

Because they're unsigned, the first launch is blocked:
- **macOS**: open it once, then System Settings → Privacy & Security → **Open Anyway**
  (or `xattr -dr com.apple.quarantine /Applications/openComposer.app`).
- **Windows**: SmartScreen → More info → **Run anyway**.

## Layout

```
crates/c4   Director client: protocol, model, diff, ops, .c4p, SDDP, driver search
app         Tauri app: state, approvals, MCP server, stdio bridge, agent runner, commands
ui          React front end
poc         the original read-only Python probes
```
