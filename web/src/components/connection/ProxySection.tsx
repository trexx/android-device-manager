import { useProxy } from "../../context/ProxyContext";

/** The shared relay endpoint: URL + auth token, entered once and used by the
 *  Network, ADB-server, and Favorites sections alike. */
export function ProxySection() {
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
        <code>wss://</code> in production — WebUSB needs a secure origin
        anyway. Saved in this browser only.
      </p>
    </section>
  );
}
