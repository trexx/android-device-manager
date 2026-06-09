import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@xterm/xterm/css/xterm.css";
import "./App.css";

// NOTE: deliberately not wrapped in <StrictMode>. Strict mode double-invokes
// effects in development, which would open/close a second ADB PTY (and could
// race the USB claim) for the shell terminal. Hardware sessions don't tolerate
// that well, so it's left off.
const container = document.getElementById("root");
if (!container) {
  throw new Error('Root element "#root" not found');
}
createRoot(container).render(<App />);
