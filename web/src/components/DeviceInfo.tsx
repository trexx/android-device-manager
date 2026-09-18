import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectedDevice } from "../context/DeviceContext";
import { getDeviceInfo, type DeviceInfo as DeviceInfoData } from "../lib/device-info";

export function DeviceInfo({ device }: { device: ConnectedDevice }) {
  const [info, setInfo] = useState<DeviceInfoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may touch state: a Refresh mid-load, a device
  // switch, or an unmount must not let an older result land.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await getDeviceInfo(device.adb);
      if (requestId.current === id) setInfo(data);
    } catch (e) {
      if (requestId.current === id) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [device]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current++; // invalidate whatever is in flight
    };
  }, [load]);

  return (
    <div className="device-info">
      <div className="panel-header">
        <h2>Device Info</h2>
        <button onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {info && (
        <dl className="info-grid">
          <Item label="Manufacturer" value={info.manufacturer} />
          <Item label="Model" value={info.model} />
          <Item label="Android" value={`${info.androidVersion} (SDK ${info.sdk})`} />
          <Item label="Serial" value={info.serial} />
          <Item
            label="Battery"
            value={
              info.battery
                ? `${info.battery.level ?? "?"}% · ${info.battery.status}`
                : "—"
            }
          />
          <Item
            label="Storage (/data)"
            value={
              info.storage
                ? `${info.storage.used} / ${info.storage.size} used (${info.storage.usePercent})`
                : "—"
            }
          />
          <Item label="Resolution" value={info.resolution ?? "—"} />
        </dl>
      )}
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
