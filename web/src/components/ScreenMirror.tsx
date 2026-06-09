import { useCallback, useEffect, useRef, useState } from "react";
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyPointerId,
} from "@yume-chan/scrcpy";
import type { ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";
import type { ConnectedDevice } from "../context/DeviceContext";
import { startScrcpy, type ScrcpySession } from "../lib/scrcpy-client";

const RESOLUTIONS = [
  { label: "Full", value: 0 },
  { label: "1080p", value: 1920 },
  { label: "720p", value: 1280 },
  { label: "480p", value: 800 },
];
const BITRATES = [
  { label: "8 Mbps", value: 8_000_000 },
  { label: "4 Mbps", value: 4_000_000 },
  { label: "2 Mbps", value: 2_000_000 },
  { label: "1 Mbps", value: 1_000_000 },
];
const KEY_MAP: Record<string, AndroidKeyCode> = {
  Enter: AndroidKeyCode.Enter,
  Backspace: AndroidKeyCode.Backspace,
  Tab: AndroidKeyCode.Tab,
  ArrowUp: AndroidKeyCode.ArrowUp,
  ArrowDown: AndroidKeyCode.ArrowDown,
  ArrowLeft: AndroidKeyCode.ArrowLeft,
  ArrowRight: AndroidKeyCode.ArrowRight,
  " ": AndroidKeyCode.Space,
};

let webglPreference: boolean | null = null;
/**
 * Prefer the (faster) WebGL renderer, but fall back to Bitmap on ANGLE's Vulkan
 * backend: there, WebGL can't import an external-sampling (YUV) hardware
 * `VideoFrame` into a GL texture, so it renders a silent black frame
 * (`texImage2D` sets `GL_INVALID_OPERATION` but doesn't throw, and the incomplete
 * texture samples as opaque black — indistinguishable from a real dark screen, so
 * there's nothing to try/catch at runtime). We detect that backend up front and
 * cache the result. Other backends (D3D, Metal, ANGLE-GL, SwiftShader) import
 * fine, so they use WebGL.
 */
function preferWebgl(): boolean {
  if (webglPreference !== null) return webglPreference;
  webglPreference = (() => {
    if (!WebGLVideoFrameRenderer.isSupported) return false;
    try {
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
      if (!gl) return false;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      return !/vulkan/i.test(name);
    } catch {
      return true; // couldn't probe — honour the WebGL preference
    }
  })();
  return webglPreference;
}

interface ActiveSession {
  session: ScrcpySession;
  decoder: WebCodecsVideoDecoder;
  canvas: HTMLCanvasElement;
  detach: () => void;
}

function attachInput(canvas: HTMLCanvasElement, controller: ScrcpyControlMessageWriter): () => void {
  let down = false;

  const sendTouch = (action: AndroidMotionEventAction, e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    void controller.injectTouch({
      action,
      pointerId: ScrcpyPointerId.Finger,
      pointerX: Math.round(x * canvas.width),
      pointerY: Math.round(y * canvas.height),
      videoWidth: canvas.width,
      videoHeight: canvas.height,
      pressure: action === AndroidMotionEventAction.Up ? 0 : 1,
      actionButton:
        action === AndroidMotionEventAction.Move
          ? AndroidMotionEventButton.None
          : AndroidMotionEventButton.Primary,
      buttons: action === AndroidMotionEventAction.Up ? 0 : AndroidMotionEventButton.Primary,
    });
  };

  const onDown = (e: PointerEvent) => {
    down = true;
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    sendTouch(AndroidMotionEventAction.Down, e);
  };
  const onMove = (e: PointerEvent) => {
    if (down) sendTouch(AndroidMotionEventAction.Move, e);
  };
  const onUp = (e: PointerEvent) => {
    if (!down) return;
    down = false;
    sendTouch(AndroidMotionEventAction.Up, e);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer already released.
    }
  };
  const onKey = (e: KeyboardEvent) => {
    const mapped = KEY_MAP[e.key];
    if (mapped !== undefined) {
      e.preventDefault();
      void controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode: mapped, repeat: 0, metaState: 0 });
      void controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode: mapped, repeat: 0, metaState: 0 });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      void controller.injectText(e.key);
    }
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("keydown", onKey);
  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.removeEventListener("keydown", onKey);
  };
}

export function ScreenMirror({ device }: { device: ConnectedDevice }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ActiveSession | null>(null);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxSize, setMaxSize] = useState(1280);
  const [bitRate, setBitRate] = useState(4_000_000);

  const stop = useCallback(() => {
    const active = sessionRef.current;
    if (!active) return;
    sessionRef.current = null;
    active.detach();
    try {
      active.decoder.dispose();
    } catch {
      // Already disposed.
    }
    active.canvas.remove();
    void active.session.close().catch(() => {});
    setRunning(false);
  }, []);

  // Stop the session when the panel unmounts.
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    if (!WebCodecsVideoDecoder.isSupported) {
      setError(
        "This browser lacks WebCodecs (needed for hardware video decode). Use a recent Chromium-based browser.",
      );
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const session = await startScrcpy(device.adb, { maxSize, videoBitRate: bitRate });
      const canvas = document.createElement("canvas");
      canvas.className = "sm-canvas";
      canvas.tabIndex = 0;
      const renderer = preferWebgl()
        ? new WebGLVideoFrameRenderer(canvas)
        : new BitmapVideoFrameRenderer(canvas);
      const decoder = new WebCodecsVideoDecoder({
        codec: session.videoStream.metadata.codec,
        renderer,
      });
      void session.videoStream.stream.pipeTo(decoder.writable).catch((e: unknown) => {
        if (sessionRef.current?.session === session) {
          setError(`Video stream stopped: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      const detach = session.controller ? attachInput(canvas, session.controller) : () => {};
      hostRef.current?.appendChild(canvas);
      sessionRef.current = { session, decoder, canvas, detach };
      setRunning(true);
      void session.exited.then(() => {
        if (sessionRef.current?.session === session) stop();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [device, maxSize, bitRate, stop]);

  const tapKey = useCallback((keyCode: AndroidKeyCode) => {
    const c = sessionRef.current?.session.controller;
    if (!c) return;
    void c.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode, repeat: 0, metaState: 0 });
    void c.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode, repeat: 0, metaState: 0 });
  }, []);

  const rotate = useCallback(() => {
    void sessionRef.current?.session.controller?.rotateDevice();
  }, []);

  const screenshot = useCallback(async () => {
    const blob = await sessionRef.current?.decoder.snapshot();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `screenshot-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <div className="screen-mirror">
      <div className="sm-toolbar">
        {!running ? (
          <>
            <label className="lc-field">
              <span>Resolution</span>
              <select
                value={maxSize}
                onChange={(e) => setMaxSize(Number(e.target.value))}
                disabled={starting}
              >
                {RESOLUTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="lc-field">
              <span>Bitrate</span>
              <select
                value={bitRate}
                onChange={(e) => setBitRate(Number(e.target.value))}
                disabled={starting}
              >
                {BITRATES.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" onClick={() => void start()} disabled={starting}>
              {starting ? "Starting…" : "Start"}
            </button>
          </>
        ) : (
          <>
            <button onClick={stop}>Stop</button>
            <button onClick={() => tapKey(AndroidKeyCode.AndroidBack)}>Back</button>
            <button onClick={() => tapKey(AndroidKeyCode.AndroidHome)}>Home</button>
            <button onClick={() => tapKey(AndroidKeyCode.AndroidAppSwitch)}>Recents</button>
            <button onClick={() => tapKey(AndroidKeyCode.VolumeDown)}>Vol−</button>
            <button onClick={() => tapKey(AndroidKeyCode.VolumeUp)}>Vol+</button>
            <button onClick={() => tapKey(AndroidKeyCode.Power)}>Power</button>
            <button onClick={rotate}>Rotate</button>
            <button onClick={() => void screenshot()}>Screenshot</button>
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="sm-stage">
        <div className="sm-canvas-host" ref={hostRef} />
        {!running && !starting && (
          <p className="muted sm-placeholder">Press Start to mirror the screen.</p>
        )}
        {starting && <p className="muted sm-placeholder">Starting…</p>}
      </div>
    </div>
  );
}
