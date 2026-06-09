import { useCallback, useEffect, useState } from "react";
import type { ConnectedDevice } from "../context/DeviceContext";
import { getDeviceInfo, type DeviceInfo as DeviceInfoData } from "../lib/device-info";

export function DeviceInfo({ device }: { device: ConnectedDevice }) {
  const [info, setInfo] = useState<DeviceInfoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInfo(await getDeviceInfo(device.adb));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [device]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getDeviceInfo(device.adb)
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [device]);

  return (
    <div className="device-info">
      <div className="panel-header">
        <h2>Device Info</h2>
        <button onClick={load} disabled={loading}>
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
