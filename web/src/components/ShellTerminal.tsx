import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type {
  AdbNoneProtocolPtyProcess,
  AdbShellProtocolPtyProcess,
} from "@yume-chan/adb";
import type { ConnectedDevice } from "../context/DeviceContext";

type Pty = AdbShellProtocolPtyProcess | AdbNoneProtocolPtyProcess;
type InputWriter = ReturnType<Pty["input"]["getWriter"]>;

export function ShellTerminal({ device }: { device: ConnectedDevice }) {
  const hostRef = useRef<HTMLDivElement>(null);

  // The whole session lives inside one effect keyed on the device. Opening a
  // PTY is async, so a `disposed` flag guards against the component unmounting
  // (panel/device switch) before the PTY is ready. Note: StrictMode is
  // intentionally off (see main.tsx) so this doesn't double-open.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: "#1a1b26", foreground: "#c0caf5" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let disposed = false;
    let pty: Pty | undefined;
    let shellPty: AdbShellProtocolPtyProcess | undefined;
    let writer: InputWriter | undefined;
    const encoder = new TextEncoder();

    (async () => {
      const subprocess = device.adb.subprocess;
      // Prefer the shell (v2) protocol: it carries window-resize and a numeric
      // exit code. Fall back to the legacy protocol on older devices.
      const shellProtocol = subprocess.shellProtocol;
      if (shellProtocol) {
        shellPty = await shellProtocol.pty({ terminalType: "xterm-256color" });
        pty = shellPty;
      } else {
        pty = await subprocess.noneProtocol.pty();
      }

      if (disposed) {
        await pty.kill();
        return;
      }

      await shellPty?.resize(term.rows, term.cols);

      // Device output -> terminal.
      const reader = pty.output.getReader();
      (async () => {
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done || disposed) break;
            if (result.value) term.write(result.value);
          }
        } catch {
          // Stream closed (device disconnected or session killed).
        }
      })();

      // Terminal input -> device.
      writer = pty.input.getWriter();
      term.onData((data) => {
        writer?.write(encoder.encode(data)).catch(() => {});
      });

      pty.exited
        .then(() => {
          if (!disposed) term.writeln("\r\n\x1b[2m[process exited]\x1b[0m");
        })
        .catch(() => {});
    })().catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      term.writeln(`\r\n\x1b[31mFailed to start shell: ${message}\x1b[0m`);
    });

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        // Host not laid out yet; ignore.
      }
      shellPty?.resize(term.rows, term.cols).catch(() => {});
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      try {
        writer?.releaseLock();
      } catch {
        // Writer may already be released.
      }
      void pty?.kill();
      term.dispose();
    };
  }, [device]);

  return <div className="terminal-host" ref={hostRef} />;
}
