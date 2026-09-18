import { describe, expect, it } from "vitest";
import { parseBattery, parseDf, parseResolution } from "./device-info";

describe("parseBattery", () => {
  it("reads the level and maps the status code", () => {
    const raw = "Current Battery Service state:\n  AC powered: false\n  level: 87\n  status: 3\n";
    expect(parseBattery(raw)).toEqual({ level: 87, status: "Discharging" });
  });

  it("tolerates unknown codes and missing fields", () => {
    expect(parseBattery("  status: 9\n")).toEqual({ level: null, status: "Unknown" });
    expect(parseBattery("")).toBeNull();
    expect(parseBattery("nothing useful")).toBeNull();
  });
});

describe("parseDf", () => {
  it("takes the last row of df -h", () => {
    const raw = "Filesystem      Size  Used Avail Use% Mounted on\n/dev/block/dm-5 108G   18G   90G  17% /data\n";
    expect(parseDf(raw)).toEqual({ size: "108G", used: "18G", available: "90G", usePercent: "17%" });
  });

  it("returns null without a data row", () => {
    expect(parseDf("Filesystem Size Used Avail Use% Mounted on\n")).toBeNull();
    expect(parseDf("")).toBeNull();
  });
});

describe("parseResolution", () => {
  it("prefers the physical size and falls back to the override", () => {
    expect(parseResolution("Physical size: 1080x2400\nOverride size: 720x1600\n")).toBe("1080x2400");
    expect(parseResolution("Override size: 720x1600")).toBe("720x1600");
    expect(parseResolution("wm: command not found")).toBeNull();
  });
});
