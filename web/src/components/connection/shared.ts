import type { useDevices } from "../../context/DeviceContext";
import type { BookmarkKind, BookmarksStore } from "../../lib/bookmarks";

export type Devices = ReturnType<typeof useDevices>["devices"];
export type AddDevice = ReturnType<typeof useDevices>["addDevice"];

export function parsePort(value: string): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Shared ☆ Save flow: validate, prompt for a name, persist. Returns the
 *  message for `setError` (null on success or cancel). */
export function promptSaveFavorite(
  store: BookmarksStore,
  kind: BookmarkKind,
  rawHost: string,
  rawPort: string,
): string | null {
  const host = rawHost.trim();
  const port = parsePort(rawPort);
  if (!host || port === null) {
    return "Enter the device IP and port before saving.";
  }
  const name = window.prompt("Name this device", host);
  if (!name?.trim()) return null;
  store.save({ name: name.trim(), kind, host, port });
  return null;
}
