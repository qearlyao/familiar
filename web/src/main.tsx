import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { applyTheme, loadMode, watchSystemTheme } from "./lib/theme";
import { initNotifications } from "./lib/notifications";

applyTheme(loadMode());
initNotifications();
watchSystemTheme(loadMode);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
