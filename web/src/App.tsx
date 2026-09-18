import { lazy, Suspense, useState, type ReactNode } from "react";
import { DeviceProvider, useDevices, type ConnectedDevice } from "./context/DeviceContext";
import { ProxyProvider } from "./context/ProxyContext";
import { ConnectionManager } from "./components/connection/ConnectionManager";
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

const PANELS = [
  { id: "info", label: "Device Info" },
  { id: "shell", label: "Shell" },
  { id: "files", label: "Files" },
  { id: "apps", label: "Apps" },
  { id: "logcat", label: "Logcat" },
  { id: "screen", label: "Screen" },
] as const;
type Panel = (typeof PANELS)[number]["id"];

/**
 * One device's tab strip and panels. A panel mounts the first time it is
 * opened and then stays mounted — hidden, not unmounted — so a shell session,
 * a logcat stream, or a mirror survives switching tabs. There is one workspace
 * per connected device, so switching devices preserves them too; a workspace
 * unmounts (ending its sessions) only when its device is disconnected.
 */
function DeviceWorkspace({ device, active }: { device: ConnectedDevice; active: boolean }) {
  const [panel, setPanel] = useState<Panel>("info");
  const [visited, setVisited] = useState<ReadonlySet<Panel>>(() => new Set<Panel>(["info"]));

  const open = (next: Panel) => {
    setPanel(next);
    if (!visited.has(next)) setVisited((prev) => new Set(prev).add(next));
  };

  const slot = (id: Panel, node: ReactNode) =>
    visited.has(id) ? (
      <div key={id} className="panel-slot" hidden={panel !== id}>
        {node}
      </div>
    ) : null;

  return (
    <main className="workspace" hidden={!active}>
      <nav className="panel-tabs" aria-label="Panels">
        {PANELS.map((p) => (
          <button key={p.id} className={panel === p.id ? "active" : ""} onClick={() => open(p.id)}>
            {p.label}
          </button>
        ))}
      </nav>
      <section className="panel">
        <Suspense fallback={<p className="muted">Loading…</p>}>
          {slot("info", <DeviceInfo device={device} />)}
          {slot("shell", <ShellTerminal device={device} />)}
          {slot("files", <FileBrowser device={device} />)}
          {slot("apps", <AppManager device={device} />)}
          {slot("logcat", <LogcatViewer device={device} />)}
          {slot(
            "screen",
            <ScreenMirror device={device} hidden={!active || panel !== "screen"} />,
          )}
        </Suspense>
      </section>
    </main>
  );
}

function Workspace() {
  const { devices, activeId } = useDevices();

  return (
    <div className="app">
      <header className="app-header">
        <h1>Android Device Manager</h1>
        <ConnectionManager />
      </header>

      <DeviceSwitcher />

      {devices.length === 0 ? (
        <main className="empty-state">
          <p>No devices connected. Connect a device above to begin.</p>
        </main>
      ) : (
        devices.map((d) => (
          <DeviceWorkspace key={d.id} device={d} active={d.id === activeId} />
        ))
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
