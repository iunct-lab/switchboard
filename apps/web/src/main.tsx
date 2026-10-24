/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

// PWA (#26): only in a build served by the daemon (not Vite's dev server) and where the browser allows it (HTTPS or localhost).
if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) void navigator.serviceWorker.register("/sw.js");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
