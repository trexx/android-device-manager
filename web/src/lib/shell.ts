import type { Adb } from "@yume-chan/adb";

/**
 * Run a one-shot shell command and return its stdout as text.
 *
 * Prefers the shell (v2) protocol when the device supports it (clean stdout /
 * stderr separation and exit codes), otherwise falls back to the legacy
 * protocol where stdout and stderr are interleaved.
 *
 * Tango joins an array command with spaces *without* quoting (it runs under
 * `sh -c`), so the array form is a convenience, not an escaping mechanism —
 * validate or `escapeArg` anything user-derived before it gets here.
 */
export async function runCommand(
  adb: Adb,
  command: string | readonly string[],
): Promise<string> {
  const shellProtocol = adb.subprocess.shellProtocol;
  if (shellProtocol) {
    const result = await shellProtocol.spawn(command).wait().toString();
    return result.stdout;
  }
  return await adb.subprocess.noneProtocol.spawn(command).wait().toString();
}

/**
 * Like {@link runCommand}, but a non-zero exit code is a failure, reported
 * with stderr (or stdout) as the message. Devices without the shell v2
 * protocol give no exit code, so there the output is returned as-is.
 */
export async function runChecked(
  adb: Adb,
  command: string | readonly string[],
): Promise<string> {
  const shellProtocol = adb.subprocess.shellProtocol;
  if (!shellProtocol) {
    return await adb.subprocess.noneProtocol.spawn(command).wait().toString();
  }
  const { stdout, stderr, exitCode } = await shellProtocol.spawn(command).wait().toString();
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || "command failed";
    throw new Error(`${detail} (exit code ${exitCode})`);
  }
  return stdout;
}
