import type { Adb, AdbDaemonConnection } from "@yume-chan/adb";
import { AdbPacket, AdbPacketSerializeStream } from "@yume-chan/adb";
import { StructDeserializeStream } from "@yume-chan/stream-extra";
import { authenticate } from "./adb-manager";
import { proxyBase } from "./proxy-url";
import { openWsByteDuplex } from "./ws-stream";

export interface NetworkConnectionOptions {
  /** Proxy base URL, e.g. `ws://localhost:8080` or `wss://proxy.example.com`. */
  proxyUrl: string;
  /** Device IP address (must be inside the proxy's allowed subnets). */
  host: string;
  /** Device ADB port (default 5555). */
  port: number;
  /** Shared secret the proxy requires on every upgrade. */
  token: string;
}

function buildConnectUrl({ proxyUrl, host, port, token }: NetworkConnectionOptions): string {
  const base = proxyBase(proxyUrl);
  // Browsers can't set request headers on a WebSocket, so the token rides in
  // the query string; URLSearchParams percent-encodes it for us.
  const params = new URLSearchParams({ host, port: String(port), token });
  return `${base}/connect?${params.toString()}`;
}

/**
 * Connect to a device over the network through the Rust WebSocket proxy
 * (direct-to-`adbd`, daemon mode).
 *
 * The WebSocket carries the raw ADB byte stream (exactly what would travel over
 * TCP to `adbd`). We deserialize incoming bytes into ADB packets and serialize
 * outgoing packets back to bytes, producing an {@link AdbDaemonConnection} that
 * is fed through the same `authenticate()` path as USB — so the resulting `Adb`
 * is transport-agnostic and every panel works identically.
 */
export async function connectNetwork(options: NetworkConnectionOptions): Promise<Adb> {
  const duplex = await openWsByteDuplex(buildConnectUrl(options));

  // Outgoing ADB packets -> bytes -> WebSocket; incoming bytes -> ADB packets.
  const serializer = new AdbPacketSerializeStream();
  void serializer.readable.pipeTo(duplex.writable).catch(duplex.close);

  const connection: AdbDaemonConnection = {
    readable: duplex.readable.pipeThrough(new StructDeserializeStream(AdbPacket)),
    writable: serializer.writable,
  };

  return authenticate(`${options.host}:${options.port}`, connection);
}
