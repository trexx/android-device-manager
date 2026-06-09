import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectedDevice } from "../context/DeviceContext";
import {
  clearData,
  forceStop,
  getPackageDetails,
  installApk,
  listPackages,
  setEnabled,
  uninstall,
  type AppPackage,
  type PackageDetails,
  type PackageFilter,
} from "../lib/app-manager";

export function AppManager({ device }: { device: ConnectedDevice }) {
  const [filter, setFilter] = useState<PackageFilter>("third-party");
  const [search, setSearch] = useState("");
  const [packages, setPackages] = useState<AppPackage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<PackageDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const apkInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPackages(await listPackages(device.adb, filter));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPackages(null);
    } finally {
      setLoading(false);
    }
  }, [device, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleExpand = useCallback(
    async (pkg: string) => {
      if (expanded === pkg) {
        setExpanded(null);
        setDetails(null);
        return;
      }
      setExpanded(pkg);
      setDetails(null);
      setDetailsLoading(true);
      try {
        setDetails(await getPackageDetails(device.adb, pkg));
      } catch {
        setDetails(null);
      } finally {
        setDetailsLoading(false);
      }
    },
    [expanded, device],
  );

  const runAction = useCallback(
    async (label: string, fn: () => Promise<string>, reload = false) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const out = await fn();
        setNotice(`${label}: ${out.trim() || "done"}`);
        if (reload) await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const onToggleEnabled = (p: AppPackage) => {
    // Enable/disable is reversible, so no confirmation — unlike uninstall and
    // clear data, which can lose data.
    const next = !p.enabled;
    void runAction(next ? "Enable" : "Disable", () => setEnabled(device.adb, p.name, next), true);
  };
  const onUninstall = (p: AppPackage) => {
    if (!window.confirm(`Uninstall ${p.name}?`)) return;
    void runAction("Uninstall", () => uninstall(device.adb, p.name), true);
  };
  const onForceStop = (p: AppPackage) =>
    void runAction("Force stop", () => forceStop(device.adb, p.name));
  const onClear = (p: AppPackage) => {
    if (!window.confirm(`Clear all data for ${p.name}?`)) return;
    void runAction("Clear data", () => clearData(device.adb, p.name));
  };
  const onInstall = (file: File) =>
    void runAction(`Install ${file.name}`, () => installApk(device.adb, file), true);

  const visible = useMemo(() => {
    if (!packages) return [];
    const q = search.trim().toLowerCase();
    return q ? packages.filter((p) => p.name.toLowerCase().includes(q)) : packages;
  }, [packages, search]);

  return (
    <div className="app-manager">
      <div className="am-toolbar">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as PackageFilter)}
          disabled={busy}
        >
          <option value="third-party">Third-party</option>
          <option value="system">System</option>
          <option value="all">All</option>
        </select>
        <input
          className="am-search"
          type="text"
          placeholder="Search packages…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button onClick={() => void load()} disabled={loading || busy}>
          {loading ? "…" : "Refresh"}
        </button>
        <button onClick={() => apkInputRef.current?.click()} disabled={busy}>
          Install APK
        </button>
        <input
          ref={apkInputRef}
          type="file"
          accept=".apk"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onInstall(f);
            e.target.value = "";
          }}
        />
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="hint muted">{notice}</p>}

      <div className="am-list">
        {loading && <p className="muted fb-empty">Loading…</p>}
        {!loading && (
          <p className="muted am-count">
            {visible.length} package{visible.length === 1 ? "" : "s"}
          </p>
        )}
        {!loading &&
          visible.map((p) => (
            <div className="am-item" key={p.name}>
              <button
                className="am-row"
                onClick={() => void toggleExpand(p.name)}
                disabled={busy}
              >
                <span className="am-chevron" aria-hidden>
                  {expanded === p.name ? "▾" : "▸"}
                </span>
                <span className="am-name" title={p.name}>
                  {p.name}
                </span>
                {!p.enabled && <span className="state-badge state-unauthorized">disabled</span>}
              </button>
              {expanded === p.name && (
                <div className="am-detail">
                  {detailsLoading && <p className="muted">Loading details…</p>}
                  {!detailsLoading && details && (
                    <dl className="am-detail-grid">
                      <div>
                        <dt>Version</dt>
                        <dd>
                          {details.versionName ?? "—"}
                          {details.versionCode ? ` (${details.versionCode})` : ""}
                        </dd>
                      </div>
                      <div>
                        <dt>Path</dt>
                        <dd>{details.path ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>Installed</dt>
                        <dd>{details.firstInstall ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>Updated</dt>
                        <dd>{details.lastUpdate ?? "—"}</dd>
                      </div>
                    </dl>
                  )}
                  <div className="am-buttons">
                    <button onClick={() => onToggleEnabled(p)} disabled={busy}>
                      {p.enabled ? "Disable" : "Enable"}
                    </button>
                    <button onClick={() => onForceStop(p)} disabled={busy}>
                      Force stop
                    </button>
                    <button onClick={() => onClear(p)} disabled={busy}>
                      Clear data
                    </button>
                    <button className="fb-delete" onClick={() => onUninstall(p)} disabled={busy}>
                      Uninstall
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
