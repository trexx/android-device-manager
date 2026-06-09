import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Vite's dependency optimizer breaks the scrcpy decoder packages, and
    // pre-bundling fetch-scrcpy-server would break its `new URL('./server.bin',
    // import.meta.url)` asset reference. Exclude the whole scrcpy family.
    exclude: [
      "@yume-chan/scrcpy",
      "@yume-chan/adb-scrcpy",
      "@yume-chan/scrcpy-decoder-webcodecs",
      "@yume-chan/fetch-scrcpy-server",
    ],
    // Excluding the scrcpy packages leaves their CJS transitive deps served raw,
    // which breaks the default import (`does not provide an export named
    // 'default'`). Force-prebundle them so esbuild converts CJS -> ESM.
    include: ["yuv-buffer", "yuv-canvas"],
  },
});
