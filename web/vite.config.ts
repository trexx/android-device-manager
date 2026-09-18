import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
});
