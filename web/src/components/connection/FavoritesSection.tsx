import { useCallback, useMemo, useState } from "react";
import type { Adb } from "@yume-chan/adb";
import { useProxy } from "../../context/ProxyContext";
import { connectNetwork } from "../../lib/ws-transport";
import { createServerClient } from "../../lib/adb-server-transport";
import type { Bookmark, BookmarksStore } from "../../lib/bookmarks";
import type { AddDevice, Devices } from "./shared";

/** Server-side favorites: saved network targets that reconnect with one click. */
export function FavoritesSection({
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
