import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import type { Adb, AdbServerClient } from "@yume-chan/adb";
import { useDevices } from "../context/DeviceContext";
import { useProxy } from "../context/ProxyContext";
import {
  connectUsb,
  getAuthorizedUsbDevices,
  isWebUsbSupported,
  requestUsbDevice,
} from "../lib/usb-transport";
import { connectNetwork } from "../lib/ws-transport";
import { createServerClient } from "../lib/adb-server-transport";
import { useBookmarks } from "../lib/bookmarks";
import type { Bookmark, BookmarkKind, BookmarksStore } from "../lib/bookmarks";

// The key predates the shared ProxyContext, so stored blobs may still carry
// stale proxyUrl/token fields from the old profile shape — they're ignored
// (ProxyContext migrated them once) and dropped on the next save.
const STORAGE_KEY = "adm.network-profile";

interface NetworkTarget {
  host: string;
  port: string;
}

const DEFAULT_TARGET: NetworkTarget = {
  host: "",
  port: "5555",
};

function loadTarget(): NetworkTarget {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<NetworkTarget>;
      return {
        host: stored.host ?? DEFAULT_TARGET.host,
        port: stored.port ?? DEFAULT_TARGET.port,
      };
    }
  } catch {
    // Ignore malformed storage.
  }
  return DEFAULT_TARGET;
}

export function ConnectionManager() {
  const { devices, addDevice } = useDevices();
  const { proxy } = useProxy();
  const usbSupported = isWebUsbSupported();

  // The one bookmarks store instance for the whole panel; children receive it
  // via props so they all see the same state.
  const store = useBookmarks(proxy.proxyUrl.trim(), proxy.token);

  return (
    <div className="connection-manager">
      <div className="conn-sections">
        <ProxySection />
        <FavoritesSection store={store} devices={devices} addDevice={addDevice} />
        {usbSupported ? (
          <UsbConnect devices={devices} addDevice={addDevice} />
        ) : (
          <section className="conn-section">
            <h2>USB</h2>
            <p className="warning">
              WebUSB is unavailable here. Use a Chromium-based browser (Chrome,
              Edge) over HTTPS or http://localhost for USB. Network connections
              below work in any browser.
            </p>
          </section>
        )}
        <NetworkConnect devices={devices} addDevice={addDevice} store={store} />
        <ServerConnect devices={devices} addDevice={addDevice} store={store} />
      </div>
    </div>
  );
}

/** The shared relay endpoint: URL + auth token, entered once and used by the
 *  Network, ADB-server, and Favorites sections alike. */
function ProxySection() {
  const { proxy, setProxy } = useProxy();

  return (
    <section className="conn-section">
      <h2>Proxy</h2>
      <div className="net-form">
        <label>
          <span>Proxy URL</span>
          <input
            type="text"
            value={proxy.proxyUrl}
            onChange={(e) => setProxy({ proxyUrl: e.target.value })}
            placeholder="ws://localhost:8080"
          />
        </label>
        <label>
          <span>Auth token</span>
          <input
            type="password"
            value={proxy.token}
            onChange={(e) => setProxy({ token: e.target.value })}
            placeholder="shared secret"
          />
        </label>
      </div>
      <p className="hint muted">
        The token must match the proxy's <code>AUTH_TOKEN</code>. Use{" "}
        <code>wss://</code> in production — WebUSB and clipboard need a secure
        origin anyway. Saved in this browser only.
      </p>
    </section>
  );
}

type Devices = ReturnType<typeof useDevices>["devices"];
type AddDevice = ReturnType<typeof useDevices>["addDevice"];

// ---- Server-side favorites -------------------------------------------------

function parsePort(value: string): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Shared ☆ Save flow: validate, prompt for a name, persist. Returns the
 *  message for `setError` (null on success or cancel). */
function promptSaveFavorite(
  store: BookmarksStore,
  kind: BookmarkKind,
  rawHost: string,
  rawPort: string,
): string | null {
  const host = rawHost.trim();
  const port = parsePort(rawPort);
  if (!host || port === null) {
    return "Enter the device IP and port before saving.";
  }
  const name = window.prompt("Name this device", host);
  if (!name?.trim()) return null;
  store.save({ name: name.trim(), kind, host, port });
  return null;
}

function FavoritesSection({
  store,
  devices,
  addDevice,
}: {
  store: BookmarksStore;
  devices: Devices;
  addDevice: AddDevice;
}) {
  const { state } = store;
  const { proxy } = useProxy();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(
    async (bookmark: Bookmark) => {
      const proxyUrl = proxy.proxyUrl.trim();
      const token = proxy.token;
      const target = `${bookmark.host}:${bookmark.port}`;
      if (devices.some((d) => d.id === target)) {
        setError(`${target} is already connected.`);
        return;
      }
      setBusyId(bookmark.id);
      setError(null);
      try {
        let adb: Adb;
        if (bookmark.kind === "direct") {
          adb = await connectNetwork({
            proxyUrl,
            host: bookmark.host,
            port: bookmark.port,
            token,
          });
        } else {
          // The adb server behind the relay does the wireless connect, then
          // hands us a transport for the resulting `ip:port` serial.
          const client = createServerClient({ proxyUrl, token });
          await client.wireless.connect(target);
          adb = await client.createAdb({ serial: target });
        }
        addDevice({
          id: target,
          label: `${bookmark.name} (${target})`,
          adb,
          transport: adb.transport,
          mode: "network",
        });
        store.touch(bookmark.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [devices, addDevice, proxy, store],
  );

  const bookmarks = useMemo(
    () =>
      [...state.bookmarks].sort(
        (a, b) =>
          (b.lastConnected ?? "").localeCompare(a.lastConnected ?? "") ||
          a.name.localeCompare(b.name),
      ),
    [state.bookmarks],
  );

  // Hidden until a proxy is configured; hidden entirely when the proxy has no
  // bookmark storage (the rest of the UI works as before).
  if (!store.available) {
    return null;
  }

  return (
    <section className="conn-section">
      <h2>Favorites</h2>
      {bookmarks.length === 0 && state.status === "ready" && (
        <p className="muted">
          No saved devices yet. Connect below, then hit <strong>☆ Save</strong>.
        </p>
      )}
      {bookmarks.length > 0 && (
        <div className="favorites">
          {bookmarks.map((b) => {
            const target = `${b.host}:${b.port}`;
            const added = devices.some((d) => d.id === target);
            return (
              <div key={b.id} className="favorite">
                <span className="favorite-name" title={target}>
                  {b.name}
                </span>
                <span className="favorite-target">{target}</span>
                <span className={`kind-badge kind-${b.kind}`}>{b.kind}</span>
                <button
                  onClick={() => connect(b)}
                  disabled={busyId !== null || added}
                  title={b.kind === "direct" ? "Reconnect via /connect" : "Reconnect via the adb server"}
                >
                  {added ? "Added" : busyId === b.id ? "Connecting…" : "Connect"}
                </button>
                <button
                  className="icon"
                  onClick={() => {
                    const name = window.prompt("Rename favorite", b.name);
                    if (name?.trim()) store.rename(b.id, name.trim());
                  }}
                  disabled={busyId !== null}
                  title="Rename"
                >
                  ✎
                </button>
                <button
                  className="icon"
                  onClick={() => store.remove(b.id)}
                  disabled={busyId !== null}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      {state.status === "error" && <p className="error">{state.error}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function UsbConnect({ devices, addDevice }: { devices: Devices; addDevice: AddDevice }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState<AdbDaemonWebUsbDevice[]>([]);

  const refreshAuthorized = useCallback(() => {
    getAuthorizedUsbDevices()
      .then(setAuthorized)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshAuthorized();
  }, [refreshAuthorized]);

  const connect = useCallback(
    async (device: AdbDaemonWebUsbDevice) => {
      if (devices.some((d) => d.id === device.serial)) {
        setError(`${device.serial} is already connected.`);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const adb = await connectUsb(device);
        addDevice({
          id: adb.serial,
          label: `${adb.banner.model ?? device.name ?? device.serial} (USB)`,
          adb,
          transport: adb.transport,
          mode: "usb",
        });
        refreshAuthorized();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [devices, addDevice, refreshAuthorized],
  );

  const onRequest = useCallback(async () => {
    setError(null);
    try {
      const device = await requestUsbDevice();
      if (device) {
        await connect(device);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [connect]);

  const connectable = authorized.filter((d) => !devices.some((c) => c.id === d.serial));

  return (
    <section className="conn-section">
      <h2>USB</h2>
      <button className="primary" onClick={onRequest} disabled={busy}>
        {busy ? "Connecting…" : "Connect via USB"}
      </button>
      {connectable.length > 0 && (
        <div className="known-devices">
          <span className="muted">Previously authorized:</span>
          {connectable.map((d) => (
            <button
              key={d.serial}
              className="chip"
              onClick={() => connect(d)}
              disabled={busy}
              title={d.serial}
            >
              {d.name || d.serial}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <p className="hint muted">
        Enable USB debugging and accept the RSA prompt. Run{" "}
        <code>adb kill-server</code> first so the local ADB server doesn't claim
        the device.
      </p>
    </section>
  );
}

function NetworkConnect({
  devices,
  addDevice,
  store,
}: {
  devices: Devices;
  addDevice: AddDevice;
  store: BookmarksStore;
}) {
  const { proxy } = useProxy();
  const [target, setTarget] = useState<NetworkTarget>(loadTarget);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = (key: keyof NetworkTarget) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setTarget((t) => ({ ...t, [key]: e.target.value }));

  const onConnect = useCallback(async () => {
    const proxyUrl = proxy.proxyUrl.trim();
    const token = proxy.token;
    const host = target.host.trim();
    const port = parsePort(target.port);

    if (!proxyUrl || !token) {
      setError("Set the proxy URL and auth token in the Proxy section above.");
      return;
    }
    if (!host) {
      setError("Device IP is required.");
      return;
    }
    if (port === null) {
      setError("Port must be between 1 and 65535.");
      return;
    }
    const id = `${host}:${port}`;
    if (devices.some((d) => d.id === id)) {
      setError(`${id} is already connected.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const adb = await connectNetwork({ proxyUrl, host, port, token });
      // Persist the device target for quick reconnects (the proxy URL + token
      // are saved separately by ProxyContext).
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ host, port: String(port) }));
      } catch {
        // Storage unavailable (private mode); not fatal.
      }
      addDevice({
        id,
        label: `${adb.banner.model ?? host} (${id})`,
        adb,
        transport: adb.transport,
        mode: "network",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [proxy, target, devices, addDevice]);

  const onSaveFavorite = useCallback(() => {
    setError(promptSaveFavorite(store, "direct", target.host, target.port));
  }, [target.host, target.port, store]);

  return (
    <section className="conn-section">
      <h2>Network</h2>
      <div className="net-form">
        <label>
          <span>Device IP</span>
          <input
            type="text"
            value={target.host}
            onChange={field("host")}
            placeholder="192.168.1.50"
            disabled={busy}
          />
        </label>
        <label className="net-port">
          <span>Port</span>
          <input
            type="text"
            inputMode="numeric"
            value={target.port}
            onChange={field("port")}
            placeholder="5555"
            disabled={busy}
          />
        </label>
        <button className="primary net-connect" onClick={onConnect} disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        {store.available && (
          <button className="net-save" onClick={onSaveFavorite} disabled={busy} title="Save as favorite">
            ☆ Save
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <p className="hint muted">
        Enable wireless debugging on the device (<code>adb tcpip 5555</code>).
        Connects through the proxy configured above.
      </p>
    </section>
  );
}

type ServerDevice = AdbServerClient.Device;

/**
 * Connect through a real `adb server` behind the relay. The server handles USB,
 * mDNS discovery, and Android 11+ wireless pairing natively; the browser just
 * lists devices and turns one into a transport-agnostic `Adb`.
 */
function ServerConnect({
  devices,
  addDevice,
  store,
}: {
  devices: Devices;
  addDevice: AddDevice;
  store: BookmarksStore;
}) {
  const { proxy } = useProxy();
  const [enabled, setEnabled] = useState(false);
  const [serverDevices, setServerDevices] = useState<readonly ServerDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const clientRef = useRef<AdbServerClient | null>(null);
  const observerRef = useRef<AdbServerClient.DeviceObserver | null>(null);

  const [pairIp, setPairIp] = useState("");
  const [pairPort, setPairPort] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [connIp, setConnIp] = useState("");
  const [connPort, setConnPort] = useState("");

  const stopObserver = useCallback(() => {
    observerRef.current?.stop();
    observerRef.current = null;
  }, []);

  // Stop tracking when the component unmounts.
  useEffect(() => stopObserver, [stopObserver]);

  const enable = useCallback(async () => {
    const proxyUrl = proxy.proxyUrl.trim();
    const token = proxy.token;
    if (!proxyUrl || !token) {
      setError("Set the proxy URL and auth token in the Proxy section above.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = createServerClient({ proxyUrl, token });
      await client.getVersion(); // fail fast if the relay/adb server is unreachable
      const observer = await client.trackDevices();
      setServerDevices([...observer.current]);
      observer.onListChange((list) => setServerDevices([...list]));
      clientRef.current = client;
      observerRef.current = observer;
      setEnabled(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [proxy]);

  const disable = useCallback(() => {
    stopObserver();
    clientRef.current = null;
    setEnabled(false);
    setServerDevices([]);
    setNotice(null);
  }, [stopObserver]);

  const addServerDevice = useCallback(
    async (device: ServerDevice) => {
      const client = clientRef.current;
      if (!client) return;
      if (devices.some((d) => d.id === device.serial)) {
        setError(`${device.serial} is already connected.`);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const adb = await client.createAdb({ serial: device.serial });
        addDevice({
          id: device.serial,
          label: `${device.model ?? device.serial} (server)`,
          adb,
          transport: adb.transport,
          mode: "network",
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [devices, addDevice],
  );

  const pair = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const ip = pairIp.trim();
    const port = pairPort.trim();
    const code = pairCode.trim();
    if (!ip || !port || !code) {
      setError("Pairing needs the device IP, pairing port, and code.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.wireless.pair(`${ip}:${port}`, code);
      setNotice(`Paired with ${ip}. Now connect using the device's connect port below.`);
      setPairCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [pairIp, pairPort, pairCode]);

  const connectWireless = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const ip = connIp.trim();
    const port = connPort.trim();
    if (!ip || !port) {
      setError("Connecting needs the device IP and port.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.wireless.connect(`${ip}:${port}`);
      setNotice(`Connected to ${ip}:${port}. It should appear in the device list.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [connIp, connPort]);

  const saveWireless = useCallback(() => {
    setError(promptSaveFavorite(store, "wireless", connIp, connPort));
  }, [connIp, connPort, store]);

  if (!enabled) {
    return (
      <section className="conn-section">
        <h2>ADB server</h2>
        <button className="primary" onClick={enable} disabled={busy}>
          {busy ? "Connecting…" : "Connect to server"}
        </button>
        {error && <p className="error">{error}</p>}
        <p className="hint muted">
          Runs against a real <code>adb</code> server behind the proxy configured
          above — it handles USB, discovery, and Android 11+ wireless pairing for
          you.
        </p>
      </section>
    );
  }

  return (
    <section className="conn-section">
      <div className="panel-header">
        <h2>ADB server</h2>
        <button onClick={disable} disabled={busy}>
          Disconnect
        </button>
      </div>

      <div className="server-devices">
        {serverDevices.length === 0 && (
          <p className="muted">No devices. Pair or connect one below.</p>
        )}
        {serverDevices.map((d) => {
          const added = devices.some((c) => c.id === d.serial);
          return (
            <div key={d.serial} className="server-device">
              <span className="server-device-name" title={d.serial}>
                {d.model ?? d.serial}
              </span>
              <span className={`state-badge state-${d.state}`}>{d.state}</span>
              <button
                onClick={() => addServerDevice(d)}
                disabled={busy || added || d.state !== "device"}
              >
                {added ? "Added" : "Connect"}
              </button>
            </div>
          );
        })}
      </div>

      <details className="server-add">
        <summary>Pair / connect a device</summary>
        <div className="server-form">
          <strong>Pair (Android 11+ wireless debugging)</strong>
          <div className="server-row">
            <input
              type="text"
              value={pairIp}
              placeholder="192.168.1.50"
              onChange={(e) => setPairIp(e.target.value)}
              disabled={busy}
            />
            <input
              type="text"
              inputMode="numeric"
              value={pairPort}
              placeholder="pair port"
              onChange={(e) => setPairPort(e.target.value)}
              disabled={busy}
            />
            <input
              type="text"
              inputMode="numeric"
              value={pairCode}
              placeholder="code"
              onChange={(e) => setPairCode(e.target.value)}
              disabled={busy}
            />
            <button onClick={pair} disabled={busy}>
              Pair
            </button>
          </div>
          <strong>Connect (wireless connect port, or tcpip)</strong>
          <div className="server-row">
            <input
              type="text"
              value={connIp}
              placeholder="192.168.1.50"
              onChange={(e) => setConnIp(e.target.value)}
              disabled={busy}
            />
            <input
              type="text"
              inputMode="numeric"
              value={connPort}
              placeholder="port"
              onChange={(e) => setConnPort(e.target.value)}
              disabled={busy}
            />
            <button onClick={connectWireless} disabled={busy}>
              Connect
            </button>
            {store.available && (
              <button onClick={saveWireless} disabled={busy} title="Save as favorite">
                ☆ Save
              </button>
            )}
          </div>
        </div>
      </details>

      {notice && <p className="hint muted">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
