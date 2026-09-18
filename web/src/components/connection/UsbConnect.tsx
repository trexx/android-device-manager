import { useCallback, useEffect, useState } from "react";
import type { AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import {
  connectUsb,
  getAuthorizedUsbDevices,
  requestUsbDevice,
} from "../../lib/usb-transport";
import type { AddDevice, Devices } from "./shared";

export function UsbConnect({ devices, addDevice }: { devices: Devices; addDevice: AddDevice }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState<AdbDaemonWebUsbDevice[]>([]);

  const refreshAuthorized = useCallback(() => {
    getAuthorizedUsbDevices()
      .then(setAuthorized)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshAuthorized();
  }, [refreshAuthorized]);

  const connect = useCallback(
    async (device: AdbDaemonWebUsbDevice) => {
      if (devices.some((d) => d.id === device.serial)) {
        setError(`${device.serial} is already connected.`);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const adb = await connectUsb(device);
        addDevice({
          id: adb.serial,
          label: `${adb.banner.model ?? device.name ?? device.serial} (USB)`,
          adb,
          mode: "usb",
        });
        refreshAuthorized();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [devices, addDevice, refreshAuthorized],
  );

  const onRequest = useCallback(async () => {
    setError(null);
    try {
      const device = await requestUsbDevice();
      if (device) {
        await connect(device);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [connect]);

  const connectable = authorized.filter((d) => !devices.some((c) => c.id === d.serial));

  return (
    <section className="conn-section">
      <h2>USB</h2>
      <button className="primary" onClick={onRequest} disabled={busy}>
        {busy ? "Connecting…" : "Connect via USB"}
      </button>
      {connectable.length > 0 && (
        <div className="known-devices">
          <span className="muted">Previously authorized:</span>
          {connectable.map((d) => (
            <button
              key={d.serial}
              className="chip"
              onClick={() => connect(d)}
              disabled={busy}
              title={d.serial}
            >
              {d.name || d.serial}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <p className="hint muted">
        Enable USB debugging and accept the RSA prompt. Run{" "}
        <code>adb kill-server</code> first so the local ADB server doesn't claim
        the device.
      </p>
    </section>
  );
}
