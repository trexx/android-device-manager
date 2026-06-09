import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectedDevice } from "../context/DeviceContext";
import {
  deleteEntry,
  downloadFile,
  isNavigable,
  joinPath,
  listDir,
  parentPath,
  uploadFile,
  type AdbSyncEntry,
} from "../lib/file-browser";

const DEFAULT_PATH = "/sdcard";

function formatSize(entry: AdbSyncEntry): string {
  if (!isFile(entry)) return "—";
  let n = Number(entry.size);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

function formatTime(mtime: bigint): string {
  const ms = Number(mtime) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : "—";
}

function isFile(entry: AdbSyncEntry): boolean {
  return !isNavigable(entry);
}

function icon(entry: AdbSyncEntry): string {
  if (entry.type === 10 /* Link */) return "↪";
  return isNavigable(entry) ? "📁" : "📄";
}

export function FileBrowser({ device }: { device: ConnectedDevice }) {
  const [path, setPath] = useState(DEFAULT_PATH);
  const [entries, setEntries] = useState<AdbSyncEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await listDir(device.adb, target);
        list.sort((a, b) => {
          const ad = isNavigable(a);
          const bd = isNavigable(b);
          if (ad !== bd) return ad ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setEntries(list);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setEntries(null);
      } finally {
        setLoading(false);
      }
    },
    [device],
  );

  useEffect(() => {
    void load(path);
  }, [path, load]);

  const refresh = useCallback(() => void load(path), [load, path]);

  const onDownload = useCallback(
    async (entry: AdbSyncEntry) => {
      setBusy(true);
      setError(null);
      try {
        await downloadFile(device.adb, joinPath(path, entry.name), entry.name);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [device, path],
  );

  const onDelete = useCallback(
    async (entry: AdbSyncEntry) => {
      const full = joinPath(path, entry.name);
      if (!window.confirm(`Delete ${full}${isNavigable(entry) ? " and its contents" : ""}?`)) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await deleteEntry(device.adb, full, isNavigable(entry));
        await load(path);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [device, path, load],
  );

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        for (const file of list) {
          await uploadFile(device.adb, path, file);
        }
        await load(path);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [device, path, load],
  );

  const segments = path.split("/").filter(Boolean);

  return (
    <div className="file-browser">
      <div className="fb-toolbar">
        <nav className="fb-crumbs" aria-label="Path">
          <button className="crumb" onClick={() => setPath("/")} disabled={busy}>
            /
          </button>
          {segments.map((seg, i) => (
            <button
              key={i}
              className="crumb"
              onClick={() => setPath("/" + segments.slice(0, i + 1).join("/"))}
              disabled={busy}
            >
              {seg}
            </button>
          ))}
        </nav>
        <div className="fb-actions">
          <button onClick={() => setPath(parentPath(path))} disabled={busy || path === "/"}>
            Up
          </button>
          <button onClick={refresh} disabled={loading || busy}>
            {loading ? "…" : "Refresh"}
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={busy}>
            Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div
        className={`fb-list${dragOver ? " drag-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
        }}
      >
        {loading && <p className="muted fb-empty">Loading…</p>}
        {!loading && entries && entries.length === 0 && (
          <p className="muted fb-empty">Empty directory. Drop files here to upload.</p>
        )}
        {!loading &&
          entries?.map((entry) => (
            <div className="fb-row" key={entry.name}>
              <span className="fb-icon" aria-hidden>
                {icon(entry)}
              </span>
              {isNavigable(entry) ? (
                <button
                  className="fb-name fb-link"
                  onClick={() => setPath(joinPath(path, entry.name))}
                  disabled={busy}
                  title={entry.name}
                >
                  {entry.name}
                </button>
              ) : (
                <span className="fb-name" title={entry.name}>
                  {entry.name}
                </span>
              )}
              <span className="fb-size">{formatSize(entry)}</span>
              <span className="fb-perm" title="permissions">
                {(entry.permission & 0o777).toString(8).padStart(3, "0")}
              </span>
              <span className="fb-time">{formatTime(entry.mtime)}</span>
              <span className="fb-row-actions">
                {isFile(entry) && (
                  <button onClick={() => onDownload(entry)} disabled={busy} title="Download">
                    ↓
                  </button>
                )}
                <button
                  className="fb-delete"
                  onClick={() => onDelete(entry)}
                  disabled={busy}
                  title="Delete"
                >
                  ×
                </button>
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
