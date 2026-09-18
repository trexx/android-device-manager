import { useDevices } from "../../context/DeviceContext";
import { useProxy } from "../../context/ProxyContext";
import { isWebUsbSupported } from "../../lib/usb-transport";
import { useBookmarks } from "../../lib/bookmarks";
import { FavoritesSection } from "./FavoritesSection";
import { NetworkConnect } from "./NetworkConnect";
import { ProxySection } from "./ProxySection";
import { ServerConnect } from "./ServerConnect";
import { UsbConnect } from "./UsbConnect";

/**
 * The landing area: one section per way of connecting (USB, Network, ADB
 * server), the shared Proxy settings they rely on, and server-side Favorites.
 * Each section lives in its own file; this component only composes them.
 */
export function ConnectionManager() {
  const { devices, addDevice } = useDevices();
  const { proxy } = useProxy();
  const usbSupported = isWebUsbSupported();

  // The one bookmarks store instance for the whole panel; children receive it
  // via props so they all see the same state.
  const store = useBookmarks(proxy.proxyUrl.trim(), proxy.token);

  return (
    <div className="connection-manager">
      <div className="conn-sections">
        <ProxySection />
        <FavoritesSection store={store} devices={devices} addDevice={addDevice} />
        {usbSupported ? (
          <UsbConnect devices={devices} addDevice={addDevice} />
        ) : (
          <section className="conn-section">
            <h2>USB</h2>
            <p className="warning">
              WebUSB is unavailable here. Use a Chromium-based browser (Chrome,
              Edge) over HTTPS or http://localhost for USB. Network connections
              below work in any browser.
            </p>
          </section>
        )}
        <NetworkConnect devices={devices} addDevice={addDevice} store={store} />
        <ServerConnect devices={devices} addDevice={addDevice} store={store} />
      </div>
    </div>
  );
}
