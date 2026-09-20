import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProxyConfig } from "./ProxyContext";

const DEFAULTS = { proxyUrl: "ws://localhost:8080", token: "" };

function stubStorage(entries: Record<string, unknown>) {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("loadProxyConfig", () => {
  it("falls back to defaults with nothing stored", () => {
    stubStorage({});
    expect(loadProxyConfig()).toEqual(DEFAULTS);
  });

  it("prefers the current key and fills in missing fields", () => {
    stubStorage({
      "adm.proxy": { token: "t" },
      "adm.network-profile": { proxyUrl: "ws://old", token: "legacy" },
    });
    expect(loadProxyConfig()).toEqual({ ...DEFAULTS, token: "t" });
  });

  it("migrates from whichever legacy profile carried a token", () => {
    stubStorage({
      "adm.network-profile": { proxyUrl: "ws://net", host: "1.2.3.4" },
      "adm.server-profile": { proxyUrl: "wss://srv", token: "s" },
    });
    expect(loadProxyConfig()).toEqual({ proxyUrl: "wss://srv", token: "s" });
  });

  it("survives malformed storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => "{not json" });
    expect(loadProxyConfig()).toEqual(DEFAULTS);
  });
});
