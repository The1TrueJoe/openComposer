import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Base first — everything after it overrides. Each of the rest belongs to one area of the app.
import "./styles/base.css";
import "./styles/dialogs.css";
import "./styles/panes.css";
import "./styles/diff.css";
import "./styles/approvals.css";
import "./styles/design.css";
import "./styles/programming.css";
import "./styles/tables.css";
import "./styles/network.css";
import "./styles/agent.css";
import "./styles/settings.css";
import "./styles/connect.css";
import "./styles/control.css";

// Suppress the webview's built-in context menu (Reload, Inspect Element, Back/Forward…) so the
// app feels native. The app's own right-click menus (components/ContextMenu) open from their own
// handlers and still work — preventing the default menu doesn't stop them.
document.addEventListener("contextmenu", (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
