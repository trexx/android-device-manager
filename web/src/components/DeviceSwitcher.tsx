import { useDevices } from "../context/DeviceContext";

export function DeviceSwitcher() {
  const { devices, activeId, setActive, removeDevice } = useDevices();

  if (devices.length === 0) {
    return null;
  }

  return (
    <nav className="device-switcher" aria-label="Connected devices">
      {devices.map((device) => (
        <div
          key={device.id}
          className={`device-tab${device.id === activeId ? " active" : ""}`}
        >
          <button
            className="device-tab-label"
            onClick={() => setActive(device.id)}
            title={device.id}
          >
            <span className={`mode-dot mode-${device.mode}`} aria-hidden />
            {device.label}
          </button>
          <button
            className="device-tab-close"
            onClick={() => removeDevice(device.id)}
            title={`Disconnect ${device.label}`}
            aria-label={`Disconnect ${device.label}`}
          >
            ×
          </button>
        </div>
      ))}
    </nav>
  );
}
