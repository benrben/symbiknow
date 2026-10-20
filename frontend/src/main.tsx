import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./styles/styles.css";
import "./styles/readable-library.css";
import "./styles/redesign.css";
import "./styles/knowledge-icons.css";
import "./styles/connected-workspace.css";
import "./styles/jev-decisions.css";
import "./features/appearance/preferences";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
