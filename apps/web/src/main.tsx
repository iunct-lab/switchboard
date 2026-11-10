/// <reference types="vite/client" />
import "./zodJitless.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { lang } from "./i18n.ts";
import "./styles.css";

// PWA (#26): only in a build served by the daemon (not Vite's dev server) and where the browser allows it (HTTPS or localhost).
if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) void navigator.serviceWorker.register("/sw.js");

// index.html already says ja; writing the same value would cost the first paint a style recalc (perf-budget launch.recalcStyleCount)
if (document.documentElement.lang !== lang) document.documentElement.lang = lang;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
