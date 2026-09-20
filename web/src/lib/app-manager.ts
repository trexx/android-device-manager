import type { Adb } from "@yume-chan/adb";
import type { MaybeConsumable, ReadableStream } from "@yume-chan/stream-extra";
import { runChecked, runCommand } from "./shell";

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

export function parsePackageList(raw: string): string[] {
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
  const raw = await runCommand(adb, ["dumpsys", "package", assertPackageId(pkg)]);
  const find = (re: RegExp) => raw.match(re)?.[1]?.trim() ?? null;
  return {
    versionName: find(/versionName=(\S+)/),
    versionCode: find(/versionCode=(\d+)/),
    path: find(/codePath=(\S+)/),
    firstInstall: find(/firstInstallTime=([^\n]+)/),
    lastUpdate: find(/lastUpdateTime=([^\n]+)/),
  };
}

/**
 * Android package names are dot-separated `[A-Za-z0-9_]` segments, so anything
 * else cannot be a real id. Tango's `spawn` does not quote arguments (the
 * command runs under `sh -c`), so refusing here is what keeps a malformed id —
 * whatever its source — from reaching the shell.
 */
const PACKAGE_ID = /^[A-Za-z0-9_.]+$/;
function assertPackageId(pkg: string): string {
  if (!PACKAGE_ID.test(pkg)) {
    throw new Error(`Invalid package name: ${pkg}`);
  }
  return pkg;
}

/**
 * `pm` reports failures in stdout ("Failure [INSTALL_FAILED_…]", "Failed") and
 * on some Android versions still exits 0, so the text is checked as well as
 * the exit code.
 */
function checkPmOutput(out: string): string {
  const text = out.trim();
  if (/^(Failure|Failed)\b/m.test(text)) {
    throw new Error(text);
  }
  return out;
}

export async function setEnabled(adb: Adb, pkg: string, enabled: boolean): Promise<string> {
  const id = assertPackageId(pkg);
  return checkPmOutput(
    await runChecked(adb, enabled ? ["pm", "enable", id] : ["pm", "disable-user", "--user", "0", id]),
  );
}

export async function uninstall(adb: Adb, pkg: string): Promise<string> {
  return checkPmOutput(await runChecked(adb, ["pm", "uninstall", assertPackageId(pkg)]));
}

export async function forceStop(adb: Adb, pkg: string): Promise<string> {
  return runChecked(adb, ["am", "force-stop", assertPackageId(pkg)]);
}

export async function clearData(adb: Adb, pkg: string): Promise<string> {
  return checkPmOutput(await runChecked(adb, ["pm", "clear", assertPackageId(pkg)]));
}

/**
 * Install an APK: push it to a fixed temp path (avoids filename escaping /
 * injection), `pm install -r`, then clean up the temp file.
 */
export async function installApk(adb: Adb, file: File): Promise<string> {
  const remote = "/data/local/tmp/__adm_install.apk";
  await adb.sync.write({
    path: remote,
    readable: file.stream() as unknown as ReadableStream<MaybeConsumable<Uint8Array>>,
    permission: 0o644,
    mtime: Math.floor(Date.now() / 1000),
  });
  try {
    return checkPmOutput(await runChecked(adb, ["pm", "install", "-r", remote]));
  } finally {
    await runCommand(adb, ["rm", "-f", remote]).catch(() => {});
  }
}
