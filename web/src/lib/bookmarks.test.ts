import { describe, expect, it } from "vitest";
import { isBookmark } from "./bookmarks";

describe("isBookmark", () => {
  const valid = { id: "1", name: "Pixel", kind: "direct", host: "192.168.1.5", port: 5555 };

  it("accepts well-formed entries, with or without lastConnected", () => {
    expect(isBookmark(valid)).toBe(true);
    expect(isBookmark({ ...valid, kind: "wireless", lastConnected: "2026-09-17T00:00:00Z" })).toBe(
      true,
    );
  });

  it("rejects malformed entries", () => {
    expect(isBookmark(null)).toBe(false);
    expect(isBookmark("x")).toBe(false);
    expect(isBookmark({ ...valid, kind: "usb" })).toBe(false);
    expect(isBookmark({ ...valid, port: "5555" })).toBe(false);
    expect(isBookmark({ id: "1", name: "x", kind: "direct", port: 1 })).toBe(false);
  });
});
