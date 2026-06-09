import type { Adb } from "@yume-chan/adb";
import type { ReadableStream } from "@yume-chan/stream-extra";

export const LOG_LEVELS = ["V", "D", "I", "W", "E", "F"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LEVEL_NAMES: Record<LogLevel, string> = {
  V: "Verbose",
  D: "Debug",
  I: "Info",
  W: "Warning",
  E: "Error",
  F: "Fatal",
};

export function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

export interface LogRecord {
  id: number;
  timestamp: string;
  pid: number;
  tid: number;
  /** `null` for lines that don't match the threadtime format (e.g. separators). */
  level: LogLevel | null;
  tag: string;
  message: string;
}

// `logcat -v threadtime`:  MM-DD HH:MM:SS.mmm  PID  TID L TAG: message
const THREADTIME_RE =
  /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?):\s?(.*)$/;

export function parseLogcatLine(line: string, id: number): LogRecord {
  const m = THREADTIME_RE.exec(line);
  if (!m) {
    return { id, timestamp: "", pid: 0, tid: 0, level: null, tag: "", message: line };
  }
  return {
    id,
    timestamp: m[1],
    pid: Number(m[2]),
    tid: Number(m[3]),
    level: m[4] as LogLevel,
    tag: m[5].trim(),
    message: m[6],
  };
}

export interface LogcatStream {
  output: ReadableStream<Uint8Array>;
  kill: () => void;
}

/**
 * Start streaming `logcat -v threadtime`. Prefers the shell (v2) protocol for a
 * clean stdout; falls back to the legacy protocol. Call `kill()` to stop.
 */
export async function spawnLogcat(adb: Adb): Promise<LogcatStream> {
  const command = ["logcat", "-v", "threadtime"];
  const shell = adb.subprocess.shellProtocol;
  if (shell) {
    const process = await shell.spawn(command);
    return { output: process.stdout, kill: () => void process.kill() };
  }
  const process = await adb.subprocess.noneProtocol.spawn(command);
  return { output: process.output, kill: () => void process.kill() };
}
