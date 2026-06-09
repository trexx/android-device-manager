import { AdbServerClient } from "@yume-chan/adb";
import type { AdbIncomingSocketHandler } from "@yume-chan/adb";
import { openWsByteDuplex } from "./ws-stream";

export interface AdbServerOptions {
  /** Relay base URL, e.g. `ws://localhost:8080` or `wss://proxy.example.com`. */
  proxyUrl: string;
  /** Shared secret the relay requires (the proxy's AUTH_TOKEN). */
  token: string;
}

function buildServerUrl({ proxyUrl, token }: AdbServerOptions): string {
  const base = proxyUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ token });
  return `${base}/adb-server?${params.toString()}`;
}

/**
 * An `AdbServerClient.ServerConnector` that reaches a real `adb server` through
 * the WebSocket relay. The adb-server smart-socket protocol opens a fresh
 * connection per request, so every `connect()` opens a new WebSocket.
 *
 * Reverse tunnels aren't supported over the relay yet; forward (`localabstract`)
 * connections cover shell, sync, logcat, app management, and scrcpy.
 */
class WebSocketServerConnector implements AdbServerClient.ServerConnector {
  readonly #url: string;

  constructor(url: string) {
    this.#url = url;
  }

  async connect(
    options?: AdbServerClient.ServerConnectionOptions,
  ): Promise<AdbServerClient.ServerConnection> {
    const duplex = await openWsByteDuplex(this.#url);
    if (options?.signal) {
      if (options.signal.aborted) {
        duplex.close();
        throw options.signal.reason ?? new Error("Connection aborted");
      }
      options.signal.addEventListener("abort", () => duplex.close());
    }
    return {
      readable: duplex.readable,
      writable: duplex.writable,
      get closed(): Promise<undefined> {
        return duplex.closed.then(() => undefined);
      },
      close() {
        duplex.close();
      },
    };
  }

  addReverseTunnel(_handler: AdbIncomingSocketHandler, _address?: string): never {
    throw new Error("Reverse tunnels are not supported over the adb-server relay.");
  }

  removeReverseTunnel(): void {}

  clearReverseTunnels(): void {}
}

/**
 * Build an `AdbServerClient` that talks to a real `adb server` behind the relay.
 * Reuse one client per (proxyUrl, token) for listing, pairing, and connecting.
 *
 * The real adb server does all the native work — USB, mDNS discovery, wireless
 * pairing (`client.wireless.pair`), and TLS connect — and `client.createAdb()`
 * yields a standard transport-agnostic `Adb`, so every panel works unchanged.
 */
export function createServerClient(options: AdbServerOptions): AdbServerClient {
  return new AdbServerClient(new WebSocketServerConnector(buildServerUrl(options)));
}
