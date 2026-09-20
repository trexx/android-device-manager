import { useCallback, useState } from "react";
import { useProxy } from "../../context/ProxyContext";
import { connectNetwork } from "../../lib/ws-transport";
import type { BookmarksStore } from "../../lib/bookmarks";
import { parsePort, promptSaveFavorite, type AddDevice, type Devices } from "./shared";

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

export function NetworkConnect({
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
