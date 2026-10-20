# The openComposer UI, by folder

```
main.tsx          mounts App and loads the stylesheets, in order
App.tsx           the shell: which tab is showing, app status, approvals, the drawer, events

api/              the backend
  types.ts          every shape it answers with (mirrors app/src and crates/c4/src/{diff,ops}.rs)
  client.ts         every command this app invokes; Tauri IPC, or lib/mock.ts in a plain browser
  index.ts          import from here: `import { api, type Approval } from "../api"`

lib/              things that are not React components
  diff.ts           how a semantic diff is grouped, counted and highlighted (diff.check.ts tests it)
  connections.ts    what can connect to what, and the ops that do it
  project.ts        tree questions: where is this, which rooms, what matches a filter
  agent.ts          which approval a propose_changes call in a transcript is waiting on
  files.ts          native file pickers (paths only cross to the backend)
  shell.ts          the `Shell` every page is handed
  ui.ts             cx, useLoad, useBackendEvent, formatting
  mock.ts, fixtures.ts  the browser-only backend and its fixture house

components/       used by more than one page
  DiffView, DiffGraph, ApprovalCard, ApprovalsDrawer   the approval / diff UI
  Panes, Dialogs, ContextMenu, controls, JsonTree, Markdown, icons, setup, shell

pages/<tab>/      one folder per tab, lazy-loaded by App.tsx

styles/           one stylesheet per area, loaded base-first by main.tsx
```

Two rules: **a page never imports from another page** (shared things move to `lib/` or
`components/`), and **`lib/` holds no components**.

`npm run dev` without the app runs against the mock; add `?fresh` to the URL to see onboarding.
