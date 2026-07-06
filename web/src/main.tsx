import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { applyTheme, loadMode, watchSystemTheme } from "./lib/theme";

applyTheme(loadMode());
watchSystemTheme(loadMode);

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
