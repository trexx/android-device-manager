import { useCallback, useEffect, useRef, useState } from "react";
import type { AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import type { AdbServerClient } from "@yume-chan/adb";
import { useDevices } from "../context/DeviceContext";
import {
  connectUsb,
  getAuthorizedUsbDevices,
  isWebUsbSupported,
  requestUsbDevice,
} from "../lib/usb-transport";
import { connectNetwork } from "../lib/ws-transport";
import { createServerClient } from "../lib/adb-server-transport";

const STORAGE_KEY = "adm.network-profile";

interface NetworkProfile {
  proxyUrl: string;
  host: string;
  port: string;
  token: string;
}

const DEFAULT_PROFILE: NetworkProfile = {
  proxyUrl: "ws://localhost:8080",
  host: "",
  port: "5555",
  token: "",
};

function loadProfile(): NetworkProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_PROFILE, ...(JSON.parse(raw) as Partial<NetworkProfile>) };
    }
  } catch {
    // Ignore malformed storage.
  }
  return DEFAULT_PROFILE;
}

export function ConnectionManager() {
  const { devices, addDevice } = useDevices();
  const usbSupported = isWebUsbSupported();

  return (
    <div className="connection-manager">
      <div className="conn-sections">
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
        <NetworkConnect devices={devices} addDevice={addDevice} />
        <ServerConnect devices={devices} addDevice={addDevice} />
      </div>
    </div>
  );
}

type Devices = ReturnType<typeof useDevices>["devices"];
type AddDevice = ReturnType<typeof useDevices>["addDevice"];

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

function NetworkConnect({ devices, addDevice }: { devices: Devices; addDevice: AddDevice }) {
  const [profile, setProfile] = useState<NetworkProfile>(loadProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = (key: keyof NetworkProfile) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setProfile((p) => ({ ...p, [key]: e.target.value }));

  const onConnect = useCallback(async () => {
    const proxyUrl = profile.proxyUrl.trim();
    const host = profile.host.trim();
    const token = profile.token;
    const port = Number(profile.port);

    if (!proxyUrl || !host || !token) {
      setError("Proxy URL, device IP, and token are required.");
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
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
      // Persist the profile (including the token) for quick reconnects. The
      // token stays in this browser's localStorage and is never sent anywhere
      // except to the proxy you configured.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...profile, host, port: String(port) }));
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
  }, [profile, devices, addDevice]);

  return (
    <section className="conn-section">
      <h2>Network</h2>
      <div className="net-form">
        <label>
          <span>Proxy URL</span>
          <input
            type="text"
            value={profile.proxyUrl}
            onChange={field("proxyUrl")}
            placeholder="ws://localhost:8080"
            disabled={busy}
          />
        </label>
        <label>
          <span>Device IP</span>
          <input
            type="text"
            value={profile.host}
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
            value={profile.port}
            onChange={field("port")}
            placeholder="5555"
            disabled={busy}
          />
        </label>
        <label>
          <span>Auth token</span>
          <input
            type="password"
            value={profile.token}
            onChange={field("token")}
            placeholder="shared secret"
            disabled={busy}
          />
        </label>
        <button className="primary net-connect" onClick={onConnect} disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="hint muted">
        Enable wireless debugging on the device (<code>adb tcpip 5555</code>) and
        run the proxy. The token must match the proxy's <code>AUTH_TOKEN</code>.
      </p>
    </section>
  );
}

const SERVER_STORAGE_KEY = "adm.server-profile";

interface ServerProfile {
  proxyUrl: string;
  token: string;
}

const DEFAULT_SERVER_PROFILE: ServerProfile = {
  proxyUrl: "ws://localhost:8080",
  token: "",
};

function loadServerProfile(): ServerProfile {
  try {
    const raw = localStorage.getItem(SERVER_STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_SERVER_PROFILE, ...(JSON.parse(raw) as Partial<ServerProfile>) };
    }
  } catch {
    // Ignore malformed storage.
  }
  return DEFAULT_SERVER_PROFILE;
}

type ServerDevice = AdbServerClient.Device;

/**
 * Connect through a real `adb server` behind the relay. The server handles USB,
 * mDNS discovery, and Android 11+ wireless pairing natively; the browser just
 * lists devices and turns one into a transport-agnostic `Adb`.
 */
function ServerConnect({ devices, addDevice }: { devices: Devices; addDevice: AddDevice }) {
  const [profile, setProfile] = useState<ServerProfile>(loadServerProfile);
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
    const proxyUrl = profile.proxyUrl.trim();
    const token = profile.token;
    if (!proxyUrl || !token) {
      setError("Relay URL and token are required.");
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
      try {
        localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify(profile));
      } catch {
        // Storage unavailable (private mode); not fatal.
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [profile]);

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

  if (!enabled) {
    return (
      <section className="conn-section">
        <h2>ADB server</h2>
        <label>
          <span>Relay URL</span>
          <input
            type="text"
            value={profile.proxyUrl}
            placeholder="ws://localhost:8080"
            onChange={(e) => setProfile((p) => ({ ...p, proxyUrl: e.target.value }))}
            disabled={busy}
          />
        </label>
        <label>
          <span>Auth token</span>
          <input
            type="password"
            value={profile.token}
            placeholder="shared secret"
            onChange={(e) => setProfile((p) => ({ ...p, token: e.target.value }))}
            disabled={busy}
          />
        </label>
        <button className="primary" onClick={enable} disabled={busy}>
          {busy ? "Connecting…" : "Connect to server"}
        </button>
        {error && <p className="error">{error}</p>}
        <p className="hint muted">
          Runs against a real <code>adb</code> server behind the relay — it handles
          USB, discovery, and Android 11+ wireless pairing for you.
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
          </div>
        </div>
      </details>

      {notice && <p className="hint muted">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
