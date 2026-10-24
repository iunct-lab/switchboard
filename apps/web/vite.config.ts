import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const CORE = process.env.SWITCHBOARD_CORE_URL ?? "http://127.0.0.1:47831";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // No `changeOrigin`: the daemon's cross-site defence (core/src/auth.ts sameOrigin) requires the browser's
      // Origin host to equal the Host header. The proxy forwards Origin (http://localhost:5173) untouched, so Host
      // must stay localhost:5173 too — with changeOrigin it became 127.0.0.1:47831 and every POST and the
      // WebSocket upgrade from the dev UI was refused with 403. Host is also checked against the allowed names
      // (core/src/auth.ts hostAllowed, #1135); the dev server's localhost:5173 passes.
      // packages/core/src/devproxy.test.ts runs this config against a real daemon.
      "/api": { target: CORE },
      // A registered report is opened from /artifacts/<key>/… (#1777); the key in the path is its only credential.
      "/artifacts": { target: CORE },
      "/ws": { target: CORE.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
