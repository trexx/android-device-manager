import { useState } from "react";
import { DeviceProvider, useDevices } from "./context/DeviceContext";
import { ConnectionManager } from "./components/ConnectionManager";
import { DeviceSwitcher } from "./components/DeviceSwitcher";
import { DeviceInfo } from "./components/DeviceInfo";
import { ShellTerminal } from "./components/ShellTerminal";
import { FileBrowser } from "./components/FileBrowser";
import { AppManager } from "./components/AppManager";
import { LogcatViewer } from "./components/LogcatViewer";
import { ScreenMirror } from "./components/ScreenMirror";

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
          </section>
        </main>
      ) : (
        <main className="empty-state">
          <p>
            {devices.length === 0
              ? "No devices connected. Connect a device over USB to begin."
              : "Select a device from the tab bar."}
          </p>
        </main>
      )}
    </div>
  );
}

export function App() {
  return (
    <DeviceProvider>
      <Workspace />
    </DeviceProvider>
  );
}
