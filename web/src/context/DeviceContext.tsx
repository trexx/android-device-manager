import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import type { Adb, AdbTransport } from "@yume-chan/adb";

export type ConnectionMode = "usb" | "network";

/**
 * One connected device. Each holds an independent `Adb` instance, so panels
 * (shell, info, ...) are fully isolated per device. Built for many devices from
 * Phase 1 even though the USB flow adds them one at a time.
 */
export interface ConnectedDevice {
  id: string; // serial (USB) or host:port (network)
  label: string;
  adb: Adb;
  transport: AdbTransport;
  mode: ConnectionMode;
}

interface State {
  devices: ConnectedDevice[];
  activeId: string | null;
}

type Action =
  | { type: "add"; device: ConnectedDevice }
  | { type: "remove"; id: string }
  | { type: "setActive"; id: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "add": {
      // Re-selecting an already-connected device just focuses it.
      if (state.devices.some((d) => d.id === action.device.id)) {
        return { ...state, activeId: action.device.id };
      }
      return {
        devices: [...state.devices, action.device],
        activeId: action.device.id,
      };
    }
    case "remove": {
      const devices = state.devices.filter((d) => d.id !== action.id);
      const activeId =
        state.activeId === action.id
          ? (devices[0]?.id ?? null)
          : state.activeId;
      return { devices, activeId };
    }
    case "setActive":
      return { ...state, activeId: action.id };
    default:
      return state;
  }
}

interface DeviceContextValue {
  devices: ConnectedDevice[];
  activeId: string | null;
  activeDevice: ConnectedDevice | undefined;
  /** Register a freshly connected device and focus it. */
  addDevice: (device: ConnectedDevice) => void;
  /** User-initiated disconnect: closes the transport and drops the device. */
  removeDevice: (id: string) => void;
  setActive: (id: string) => void;
}

const DeviceContext = createContext<DeviceContextValue | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { devices: [], activeId: null });

  const addDevice = useCallback((device: ConnectedDevice) => {
    dispatch({ type: "add", device });
    // Drop the device from the list automatically if the connection drops
    // (cable unplugged, daemon restart, etc.).
    device.adb.disconnected
      .then(() => dispatch({ type: "remove", id: device.id }))
      .catch(() => dispatch({ type: "remove", id: device.id }));
  }, []);

  const removeDevice = useCallback(
    (id: string) => {
      const device = state.devices.find((d) => d.id === id);
      // Fire-and-forget close; the `disconnected` handler above performs the
      // actual state removal once the transport settles.
      device?.adb.close().catch(() => {});
      dispatch({ type: "remove", id });
    },
    [state.devices],
  );

  const setActive = useCallback((id: string) => {
    dispatch({ type: "setActive", id });
  }, []);

  const value = useMemo<DeviceContextValue>(
    () => ({
      devices: state.devices,
      activeId: state.activeId,
      activeDevice: state.devices.find((d) => d.id === state.activeId),
      addDevice,
      removeDevice,
      setActive,
    }),
    [state.devices, state.activeId, addDevice, removeDevice, setActive],
  );

  return (
    <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>
  );
}

export function useDevices(): DeviceContextValue {
  const ctx = useContext(DeviceContext);
  if (!ctx) {
    throw new Error("useDevices must be used within a DeviceProvider");
  }
  return ctx;
}
