import { lazy, Suspense, useState } from "react";
import { DeviceProvider, useDevices } from "./context/DeviceContext";
import { ProxyProvider } from "./context/ProxyContext";
import { ConnectionManager } from "./components/ConnectionManager";
import { DeviceSwitcher } from "./components/DeviceSwitcher";
import { DeviceInfo } from "./components/DeviceInfo";
import { FileBrowser } from "./components/FileBrowser";
import { AppManager } from "./components/AppManager";
import { LogcatViewer } from "./components/LogcatViewer";

// The Shell and Screen panels pull in the two heaviest dependencies (xterm, and
// the scrcpy stack plus its server binary), and neither is needed until its tab
// is opened — so they load on demand instead of in the initial bundle.
const ShellTerminal = lazy(() =>
  import("./components/ShellTerminal").then((m) => ({ default: m.ShellTerminal })),
);
const ScreenMirror = lazy(() =>
  import("./components/ScreenMirror").then((m) => ({ default: m.ScreenMirror })),
);

type Panel = "info" | "shell" | "files" | "apps" | "logcat" | "screen";

function Workspace() {
  const { devices, activeDevice } = useDevices();
  const [panel, setPanel] = useState<Panel>("info");

  return (
    <div className="app">
      <header className="app-header">
        <h1>Android Device Manager</h1>
        <ConnectionManager />
      </header>

      <DeviceSwitcher />

      {activeDevice ? (
        <main className="workspace">
          <nav className="panel-tabs" aria-label="Panels">
            <button
              className={panel === "info" ? "active" : ""}
              onClick={() => setPanel("info")}
            >
              Device Info
            </button>
            <button
              className={panel === "shell" ? "active" : ""}
              onClick={() => setPanel("shell")}
            >
              Shell
            </button>
            <button
              className={panel === "files" ? "active" : ""}
              onClick={() => setPanel("files")}
            >
              Files
            </button>
            <button
              className={panel === "apps" ? "active" : ""}
              onClick={() => setPanel("apps")}
            >
              Apps
            </button>
            <button
              className={panel === "logcat" ? "active" : ""}
              onClick={() => setPanel("logcat")}
            >
              Logcat
            </button>
            <button
              className={panel === "screen" ? "active" : ""}
              onClick={() => setPanel("screen")}
            >
              Screen
            </button>
          </nav>
          <section className="panel">
            <Suspense fallback={<p className="muted">Loading…</p>}>
            {/* Key by device id so switching devices remounts the panel with a
                fresh per-device session. */}
            {panel === "info" && (
              <DeviceInfo key={activeDevice.id} device={activeDevice} />
            )}
            {panel === "shell" && (
              <ShellTerminal key={activeDevice.id} device={activeDevice} />
            )}
            {panel === "files" && (
              <FileBrowser key={activeDevice.id} device={activeDevice} />
            )}
            {panel === "apps" && (
              <AppManager key={activeDevice.id} device={activeDevice} />
            )}
            {panel === "logcat" && (
              <LogcatViewer key={activeDevice.id} device={activeDevice} />
            )}
            {panel === "screen" && (
              <ScreenMirror key={activeDevice.id} device={activeDevice} />
            )}
            </Suspense>
          </section>
        </main>
      ) : (
        <main className="empty-state">
          <p>
            {devices.length === 0
              ? "No devices connected. Connect a device above to begin."
              : "Select a device from the tab bar."}
          </p>
        </main>
      )}
    </div>
  );
}

export function App() {
  return (
    <ProxyProvider>
      <DeviceProvider>
        <Workspace />
      </DeviceProvider>
    </ProxyProvider>
  );
}
