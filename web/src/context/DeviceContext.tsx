import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type { Adb } from "@yume-chan/adb";

export type ConnectionMode = "usb" | "network";

/**
 * One connected device. Each holds an independent `Adb` instance, so panels
 * (shell, info, ...) are fully isolated per device.
 */
export interface ConnectedDevice {
  id: string; // serial (USB) or host:port (network)
  label: string;
  adb: Adb;
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
  // Synchronous mirror of the connected set, keyed by id. Reducer state only
  // updates on render, but two connect attempts can resolve in the same tick,
  // and `disconnected` handlers must be able to tell "my entry" from a newer
  // one that reused the id.
  const entries = useRef(new Map<string, ConnectedDevice>());

  const addDevice = useCallback((device: ConnectedDevice) => {
    const existing = entries.current.get(device.id);
    if (existing) {
      // Already connected (two attempts raced, or the same device reached via
      // two transports): keep the live session, close the redundant one, and
      // just focus the tab. No `disconnected` handler is attached to the
      // orphan — it would otherwise evict the live entry when it settles.
      device.adb.close().catch(() => {});
      dispatch({ type: "setActive", id: device.id });
      return;
    }
    entries.current.set(device.id, device);
    dispatch({ type: "add", device });
    // Drop the device from the list automatically if the connection drops
    // (cable unplugged, daemon restart, etc.) — but only while this object is
    // still the one registered under its id.
    const onDisconnected = () => {
      if (entries.current.get(device.id) === device) {
        entries.current.delete(device.id);
        dispatch({ type: "remove", id: device.id });
      }
    };
    device.adb.disconnected.then(onDisconnected, onDisconnected);
  }, []);

  const removeDevice = useCallback((id: string) => {
    const device = entries.current.get(id);
    if (!device) return;
    entries.current.delete(id);
    // Fire-and-forget close; the entry is dropped right away rather than when
    // the transport settles.
    device.adb.close().catch(() => {});
    dispatch({ type: "remove", id });
  }, []);

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
