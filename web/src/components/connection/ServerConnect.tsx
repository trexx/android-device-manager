import { useCallback, useEffect, useRef, useState } from "react";
import type { AdbServerClient } from "@yume-chan/adb";
import { useProxy } from "../../context/ProxyContext";
import { createServerClient } from "../../lib/adb-server-transport";
import type { BookmarksStore } from "../../lib/bookmarks";
import { promptSaveFavorite, type AddDevice, type Devices } from "./shared";

type ServerDevice = AdbServerClient.Device;

/**
 * Connect through a real `adb server` behind the relay. The server handles USB,
 * mDNS discovery, and Android 11+ wireless pairing natively; the browser just
 * lists devices and turns one into a transport-agnostic `Adb`.
 */
export function ServerConnect({
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
    void observerRef.current?.close();
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
