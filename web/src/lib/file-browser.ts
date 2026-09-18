import type { Adb, AdbSync } from "@yume-chan/adb";
import { LinuxFileType } from "@yume-chan/adb";
import type { MaybeConsumable, ReadableStream } from "@yume-chan/stream-extra";

export { LinuxFileType };
export type AdbSyncEntry = AdbSync.OpenDir.Entry;

/** Whether an entry is a directory (or a symlink, which we let users try to enter). */
export function isNavigable(entry: AdbSyncEntry): boolean {
  return entry.type === LinuxFileType.Directory || entry.type === LinuxFileType.Link;
}

/** Join an absolute device dir with a child name. */
export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}

/** Parent directory of an absolute unix path. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimmed.slice(0, slash);
}

/**
 * List a directory. `adb.sync` is a service with a pooled set of sync sockets
 * (Tango 3), so there is no per-call session to open or dispose.
 */
export async function listDir(adb: Adb, path: string): Promise<AdbSyncEntry[]> {
  const entries = await adb.sync.readdir(path);
  return entries.filter((entry) => entry.name !== "." && entry.name !== "..");
}

/** Pull a file from the device and save it via the browser. */
export async function downloadFile(adb: Adb, path: string, name: string): Promise<void> {
  const reader = adb.sync.read(path).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  saveBlob(new Blob(chunks as BlobPart[]), name);
}

/** Push a browser File into a device directory (overwrites if it exists). */
export async function uploadFile(adb: Adb, dir: string, file: File): Promise<void> {
  await adb.sync.write({
    path: joinPath(dir, file.name),
    // A browser File's stream is a standard web ReadableStream<Uint8Array>;
    // Tango consumes it as the byte source (plain chunks are valid
    // MaybeConsumable chunks, the cast only bridges the type parameter).
    readable: file.stream() as unknown as ReadableStream<MaybeConsumable<Uint8Array>>,
    permission: 0o644,
    mtime: Math.floor(Date.now() / 1000),
  });
}

/** Delete a file or (recursively) a directory. */
export async function deleteEntry(adb: Adb, path: string, recursive: boolean): Promise<void> {
  await adb.rm(path, { recursive, force: true });
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
