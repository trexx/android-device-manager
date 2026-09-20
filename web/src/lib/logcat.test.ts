import { describe, expect, it } from "vitest";
import { levelRank, parseLogcatLine } from "./logcat";

describe("parseLogcatLine", () => {
  it("parses a threadtime line", () => {
    const line = "09-17 21:00:01.123  1234  5678 W ActivityManager: Slow operation: 120ms";
    expect(parseLogcatLine(line, 7)).toEqual({
      id: 7,
      timestamp: "09-17 21:00:01.123",
      pid: 1234,
      tid: 5678,
      level: "W",
      tag: "ActivityManager",
      message: "Slow operation: 120ms",
    });
  });

  it("keeps colons inside the message and spaces inside the tag", () => {
    const rec = parseLogcatLine("09-17 21:00:01.123     1     2 I My Tag: a: b", 1);
    expect(rec.tag).toBe("My Tag");
    expect(rec.message).toBe("a: b");
  });

  it("passes separator lines through with a null level", () => {
    const rec = parseLogcatLine("--------- beginning of main", 2);
    expect(rec.level).toBeNull();
    expect(rec.message).toBe("--------- beginning of main");
  });
});

it("ranks levels from verbose to fatal", () => {
  expect(levelRank("V")).toBeLessThan(levelRank("D"));
  expect(levelRank("E")).toBeLessThan(levelRank("F"));
});
