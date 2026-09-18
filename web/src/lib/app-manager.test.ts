import { describe, expect, it } from "vitest";
import type { Adb } from "@yume-chan/adb";
import { clearData, forceStop, parsePackageList, setEnabled, uninstall } from "./app-manager";

// Never reached: validation rejects before anything touches the device.
const noAdb = {} as Adb;

describe("parsePackageList", () => {
  it("keeps only package: lines, trimmed and non-empty", () => {
    const raw = "package:com.a\n  package:com.b  \n\nWarning: something\npackage:\n";
    expect(parsePackageList(raw)).toEqual(["com.a", "com.b"]);
  });
});

describe("package id validation", () => {
  it.each([["com.evil; rm -rf /"], ["com.a b"], [""], ["$(id)"], ["com/a"]])(
    "rejects %j before touching the device",
    async (pkg) => {
      await expect(setEnabled(noAdb, pkg, true)).rejects.toThrow(/Invalid package name/);
      await expect(uninstall(noAdb, pkg)).rejects.toThrow(/Invalid package name/);
      await expect(forceStop(noAdb, pkg)).rejects.toThrow(/Invalid package name/);
      await expect(clearData(noAdb, pkg)).rejects.toThrow(/Invalid package name/);
    },
  );
});
