import type { Adb, AdbSyncWriteOptions } from "@yume-chan/adb";
import { runCommand } from "./device-info";

export type PackageFilter = "third-party" | "system" | "all";

export interface AppPackage {
  name: string;
  enabled: boolean;
}

export interface PackageDetails {
  versionName: string | null;
  versionCode: string | null;
  path: string | null;
  firstInstall: string | null;
  lastUpdate: string | null;
}

function parsePackageList(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice("package:".length).trim())
    .filter(Boolean);
}

/**
 * List installed packages. `pm list packages -d` (disabled-only) is fetched
 * alongside to mark each package's enabled/disabled state.
 */
export async function listPackages(adb: Adb, filter: PackageFilter): Promise<AppPackage[]> {
  const flag = filter === "third-party" ? " -3" : filter === "system" ? " -s" : "";
  const [allRaw, disabledRaw] = await Promise.all([
    runCommand(adb, `pm list packages${flag}`),
    runCommand(adb, "pm list packages -d"),
  ]);
  const disabled = new Set(parsePackageList(disabledRaw));
  return parsePackageList(allRaw)
    .map((name) => ({ name, enabled: !disabled.has(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPackageDetails(adb: Adb, pkg: string): Promise<PackageDetails> {
  const raw = await runCommand(adb, `dumpsys package ${pkg}`);
  const find = (re: RegExp) => raw.match(re)?.[1]?.trim() ?? null;
  return {
    versionName: find(/versionName=(\S+)/),
    versionCode: find(/versionCode=(\d+)/),
    path: find(/codePath=(\S+)/),
    firstInstall: find(/firstInstallTime=([^\n]+)/),
    lastUpdate: find(/lastUpdateTime=([^\n]+)/),
  };
}

// Package ids come from `pm list packages` (trusted, no shell metacharacters),
// so they're safe to interpolate directly.

export function setEnabled(adb: Adb, pkg: string, enabled: boolean): Promise<string> {
  return runCommand(adb, enabled ? `pm enable ${pkg}` : `pm disable-user --user 0 ${pkg}`);
}

export function uninstall(adb: Adb, pkg: string): Promise<string> {
  return runCommand(adb, `pm uninstall ${pkg}`);
}

export function forceStop(adb: Adb, pkg: string): Promise<string> {
  return runCommand(adb, `am force-stop ${pkg}`);
}

export function clearData(adb: Adb, pkg: string): Promise<string> {
  return runCommand(adb, `pm clear ${pkg}`);
}

/**
 * Install an APK: push it to a fixed temp path (avoids filename escaping /
 * injection), `pm install -r`, then clean up the temp file.
 */
export async function installApk(adb: Adb, file: File): Promise<string> {
  const remote = "/data/local/tmp/__adm_install.apk";
  const sync = await adb.sync();
  try {
    await sync.write({
      filename: remote,
      file: file.stream() as unknown as AdbSyncWriteOptions["file"],
      permission: 0o644,
      mtime: Math.floor(Date.now() / 1000),
    });
  } finally {
    await sync.dispose();
  }
  try {
    return await runCommand(adb, `pm install -r ${remote}`);
  } finally {
    await runCommand(adb, `rm -f ${remote}`).catch(() => {});
  }
}
