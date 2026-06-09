import type { Adb } from "@yume-chan/adb";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import type {
  ScrcpyControlMessageWriter,
  ScrcpyMediaStreamPacket,
  ScrcpyVideoStreamMetadata,
} from "@yume-chan/scrcpy";
import { ReadableStream } from "@yume-chan/stream-extra";
import { BIN, VERSION } from "@yume-chan/fetch-scrcpy-server";

const SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";

export interface ScrcpyStartOptions {
  /** Max dimension in px; 0 = device resolution. */
  maxSize: number;
  /** Video bit rate in bits/sec. */
  videoBitRate: number;
}

export interface ScrcpyVideo {
  metadata: ScrcpyVideoStreamMetadata;
  stream: ReadableStream<ScrcpyMediaStreamPacket>;
}

export interface ScrcpySession {
  videoStream: ScrcpyVideo;
  controller: ScrcpyControlMessageWriter | undefined;
  exited: Promise<void>;
  close(): Promise<void>;
}

// The server binary is bundled (fetched at install time) and fetched once at
// runtime, then pushed to the device on each session start.
let serverBytes: Promise<Uint8Array> | undefined;
function getServerBytes(): Promise<Uint8Array> {
  serverBytes ??= fetch(BIN)
    .then((response) => response.arrayBuffer())
    .then((buffer) => new Uint8Array(buffer));
  return serverBytes;
}

/**
 * Push the scrcpy server to the device and start a mirroring session. Audio is
 * disabled (video + control only); the same `Adb` works over USB or network.
 */
export async function startScrcpy(adb: Adb, options: ScrcpyStartOptions): Promise<ScrcpySession> {
  const bytes = await getServerBytes();
  const file = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  await AdbScrcpyClient.pushServer(adb, file, SERVER_PATH);

  const scrcpyOptions = new AdbScrcpyOptionsLatest(
    {
      video: true,
      audio: false,
      control: true,
      // Use a forward tunnel (client connects to the device) rather than the
      // default reverse tunnel (device dials back) — reverse tunnels aren't
      // supported over the adb-server relay, and forward works everywhere.
      tunnelForward: true,
      maxSize: options.maxSize,
      videoBitRate: options.videoBitRate,
    },
    { version: VERSION },
  );

  const client = await AdbScrcpyClient.start(adb, SERVER_PATH, scrcpyOptions);
  const videoStream = await client.videoStream;
  if (!videoStream) {
    await client.close();
    throw new Error("scrcpy did not produce a video stream");
  }

  // Drain the server's log output so the connection doesn't block.
  const logReader = client.output.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done } = await logReader.read();
        if (done) break;
      }
    } catch {
      // Stream closed.
    }
  })();

  return {
    videoStream,
    controller: client.controller,
    exited: client.exited,
    close: () => client.close(),
  };
}
