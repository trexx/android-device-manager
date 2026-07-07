import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * The one proxy/relay endpoint the whole app talks to: its WebSocket URL and
 * the shared AUTH_TOKEN. Raw user strings — normalization (trim, trailing
 * slash, ws→http) stays at the edges via `proxyBase()` in lib/proxy-url.ts.
 *
 * Persisted to localStorage on change under `adm.proxy`. This replaced the
 * earlier two-profile model (`adm.network-profile` / `adm.server-profile`,
 * each carrying its own copy of the pair); `loadProxyConfig` migrates from
 * those keys once, and `adm.network-profile` lives on holding only the
 * Network section's host/port.
 */
export interface ProxyConfig {
  proxyUrl: string;
  token: string;
}

const STORAGE_KEY = "adm.proxy";
const LEGACY_NETWORK_KEY = "adm.network-profile";
const LEGACY_SERVER_KEY = "adm.server-profile";

const DEFAULT_CONFIG: ProxyConfig = {
  proxyUrl: "ws://localhost:8080",
  token: "",
};

function readJson(key: string): Partial<ProxyConfig> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      return JSON.parse(raw) as Partial<ProxyConfig>;
    }
  } catch {
    // Ignore malformed storage.
  }
  return {};
}

function loadProxyConfig(): ProxyConfig {
  const stored = readJson(STORAGE_KEY);
  if (stored.proxyUrl !== undefined || stored.token !== undefined) {
    return { ...DEFAULT_CONFIG, ...stored };
  }
  // One-time migration from the legacy per-section profiles, mirroring the
  // old "borrow whichever has a token" logic.
  const net = readJson(LEGACY_NETWORK_KEY);
  const server = readJson(LEGACY_SERVER_KEY);
  return {
    proxyUrl:
      (net.token ? net.proxyUrl : server.token ? server.proxyUrl : net.proxyUrl || server.proxyUrl) ||
      DEFAULT_CONFIG.proxyUrl,
    token: net.token || server.token || DEFAULT_CONFIG.token,
  };
}

interface ProxyContextValue {
  proxy: ProxyConfig;
  /** Merge a partial update into the config; persisted automatically. */
  setProxy: (patch: Partial<ProxyConfig>) => void;
}

const ProxyContext = createContext<ProxyContextValue | null>(null);

export function ProxyProvider({ children }: { children: ReactNode }) {
  const [proxy, setState] = useState<ProxyConfig>(loadProxyConfig);

  // Saved on change (not on successful connect): favorites and reconnects
  // should work on the next visit even if the last session never connected.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(proxy));
    } catch {
      // Storage unavailable (private mode); not fatal.
    }
  }, [proxy]);

  const setProxy = useCallback((patch: Partial<ProxyConfig>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const value = useMemo<ProxyContextValue>(() => ({ proxy, setProxy }), [proxy, setProxy]);

  return <ProxyContext.Provider value={value}>{children}</ProxyContext.Provider>;
}

export function useProxy(): ProxyContextValue {
  const ctx = useContext(ProxyContext);
  if (!ctx) {
    throw new Error("useProxy must be used within a ProxyProvider");
  }
  return ctx;
}
