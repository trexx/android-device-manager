/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Production-only Content-Security-Policy, as a <meta> tag so it applies on any
// static host. The dev server injects styles and HMR code inline, so the plugin
// is `apply: "build"`. Notes:
//  - style-src needs 'unsafe-inline': xterm injects <style> elements.
//  - connect-src allows any host: the proxy URL is user-entered (ws/wss for the
//    relays, http/https for the bookmarks API).
//  - frame-ancestors is header-only and would just log a warning, so it's left out.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self' http: https: ws: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const csp: Plugin = {
  name: "adm-csp",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
      injectTo: "head-prepend",
    },
  ],
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), csp],
  optimizeDeps: {
    // Vite's dependency optimizer breaks the scrcpy decoder packages, and
    // pre-bundling fetch-scrcpy-server would break its `new URL('./server.bin',
    // import.meta.url)` asset reference. Exclude the whole scrcpy family.
    // (Tango 3's WebCodecs decoder has no CJS transitive deps any more, so the
    // old `include: ["yuv-buffer", "yuv-canvas"]` workaround is gone.)
    exclude: [
      "@yume-chan/scrcpy",
      "@yume-chan/adb-scrcpy",
      "@yume-chan/scrcpy-decoder-webcodecs",
      "@yume-chan/fetch-scrcpy-server",
    ],
  },
  test: {
    // Pure parsers and helpers only; anything touching a device is verified
    // by hand against real hardware (see docs/development.md).
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
