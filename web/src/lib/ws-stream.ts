import { MaybeConsumable, PushReadableStream } from "@yume-chan/stream-extra";
import type { ReadableStream, WritableStream } from "@yume-chan/stream-extra";

/**
 * A WebSocket exposed as a raw byte duplex: a `ReadableStream<Uint8Array>` of
 * incoming frames and a `WritableStream` that sends outgoing bytes.
 *
 * Shared by the network transports (direct-device daemon and adb-server). The
 * inbound side buffers frames and drains them through one loop that AWAITS each
 * `enqueue` — `PushReadableStream` defers enqueues under backpressure, so naive
 * pushing would reorder bytes, which is fatal for a byte-exact protocol.
 */
export interface WsByteDuplex {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<MaybeConsumable<Uint8Array>>;
  /** Resolves when the underlying WebSocket closes. */
  closed: Promise<void>;
  close(): void;
}

export async function openWsByteDuplex(url: string): Promise<WsByteDuplex> {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Could not connect to ${url}. Check the URL, token, and that the proxy is reachable.`));
    };
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });

  let wsClosed = false;
  const close = () => {
    if (!wsClosed) {
      wsClosed = true;
      try {
        ws.close();
      } catch {
        // Already closing/closed.
      }
    }
  };

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const queue: Uint8Array[] = [];
  let ended = false;
  let failure: unknown;
  let wake: (() => void) | null = null;

  ws.addEventListener("message", (event) => {
    queue.push(new Uint8Array(event.data as ArrayBuffer));
    wake?.();
  });
  ws.addEventListener("close", () => {
    ended = true;
    wsClosed = true;
    resolveClosed();
    wake?.();
  });
  ws.addEventListener("error", () => {
    failure ??= new Error("WebSocket connection error");
    wake?.();
  });

  const readable = new PushReadableStream<Uint8Array>(async (controller) => {
    for (;;) {
      while (queue.length > 0) {
        const accepted = await controller.enqueue(queue.shift()!);
        if (!accepted) {
          close();
          return;
        }
      }
      if (failure !== undefined) {
        controller.error(failure);
        return;
      }
      if (ended) {
        controller.close();
        return;
      }
      // The executor runs synchronously (no await between the checks above and
      // here), so a signal can't be missed; the inner guard catches races.
      await new Promise<void>((resolve) => {
        wake = () => {
          wake = null;
          resolve();
        };
        if (queue.length > 0 || ended || failure !== undefined) {
          wake();
        }
      });
    }
  });

  const writable = new MaybeConsumable.WritableStream<Uint8Array>({
    write: (chunk) => {
      // ADB payloads are backed by a regular ArrayBuffer, never a
      // SharedArrayBuffer; assert that for WebSocket.send's typing.
      ws.send(chunk as Uint8Array<ArrayBuffer>);
    },
    close,
    abort: close,
  });

  return { readable, writable, closed, close };
}
