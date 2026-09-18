import { describe, expect, it } from "vitest";
import { joinPath, parentPath } from "./file-browser";

describe("joinPath", () => {
  it("joins without doubling slashes", () => {
    expect(joinPath("/", "a")).toBe("/a");
    expect(joinPath("/sdcard", "DCIM")).toBe("/sdcard/DCIM");
    expect(joinPath("/sdcard/", "DCIM")).toBe("/sdcard/DCIM");
  });
});

describe("parentPath", () => {
  it("walks up to the root and stays there", () => {
    expect(parentPath("/sdcard/DCIM")).toBe("/sdcard");
    expect(parentPath("/sdcard/DCIM/")).toBe("/sdcard");
    expect(parentPath("/sdcard")).toBe("/");
    expect(parentPath("/")).toBe("/");
  });
});
