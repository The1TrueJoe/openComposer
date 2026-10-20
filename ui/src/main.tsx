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
import "./styles/tables.css";
import "./styles/network.css";
import "./styles/agent.css";
import "./styles/settings.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
