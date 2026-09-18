import type { Adb } from "@yume-chan/adb";
import { runCommand } from "./shell";

export interface BatteryInfo {
  level: number | null; // percentage 0-100
  status: string; // human-readable charging status
}

export interface StorageInfo {
  size: string;
  used: string;
  available: string;
  usePercent: string;
}

export interface DeviceInfo {
  serial: string;
  manufacturer: string;
  model: string;
  androidVersion: string;
  sdk: string;
  battery: BatteryInfo | null;
  storage: StorageInfo | null;
  resolution: string | null;
}

// `dumpsys battery` status codes, per Android's BatteryManager.
const BATTERY_STATUS: Record<string, string> = {
  "1": "Unknown",
  "2": "Charging",
  "3": "Discharging",
  "4": "Not charging",
  "5": "Full",
};

export function parseBattery(raw: string): BatteryInfo | null {
  if (!raw) return null;
  const levelMatch = raw.match(/^\s*level:\s*(\d+)/m);
  const statusMatch = raw.match(/^\s*status:\s*(\d+)/m);
  if (!levelMatch && !statusMatch) return null;
  return {
    level: levelMatch ? Number(levelMatch[1]) : null,
    status: statusMatch ? (BATTERY_STATUS[statusMatch[1]] ?? "Unknown") : "Unknown",
  };
}

export function parseDf(raw: string): StorageInfo | null {
  // Expected (df -h /data):
  //   Filesystem  Size  Used Avail Use% Mounted on
  //   /dev/...    108G   18G   90G  17% /data
  const lines = raw.trim().split("\n");
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  if (cols.length < 5) return null;
  return {
    size: cols[1],
    used: cols[2],
    available: cols[3],
    usePercent: cols[4],
  };
}

export function parseResolution(raw: string): string | null {
  // `wm size` -> "Physical size: 1080x2400" (and maybe "Override size: ...")
  const match = raw.match(/(?:Physical|Override) size:\s*([\dx]+)/);
  return match ? match[1] : null;
}

/**
 * Collect a snapshot of device properties and runtime stats. Property reads use
 * `getprop`; battery / storage / resolution use shell dumps. Any individual
 * shell dump that fails degrades to `null` rather than failing the whole read.
 */
export async function getDeviceInfo(adb: Adb): Promise<DeviceInfo> {
  const [manufacturer, model, androidVersion, sdk] = await Promise.all([
    adb.getProp("ro.product.manufacturer"),
    adb.getProp("ro.product.model"),
    adb.getProp("ro.build.version.release"),
    adb.getProp("ro.build.version.sdk"),
  ]);

  const [batteryRaw, dfRaw, wmRaw] = await Promise.all([
    runCommand(adb, "dumpsys battery").catch(() => ""),
    runCommand(adb, "df -h /data").catch(() => ""),
    runCommand(adb, "wm size").catch(() => ""),
  ]);

  return {
    serial: adb.serial,
    manufacturer,
    model,
    androidVersion,
    sdk,
    battery: parseBattery(batteryRaw),
    storage: parseDf(dfRaw),
    resolution: parseResolution(wmRaw),
  };
}
