/**
 * Client for the proxy's `/bookmarks` endpoint: one JSON document of saved
 * devices, persisted server-side so favorites roam across browsers instead of
 * living in each one's localStorage.
 *
 * The document is fetched and replaced wholesale (GET / PUT) — the proxy
 * stores it as an opaque blob and this module owns the schema. The proxy's
 * AUTH_TOKEN rides in the `Authorization` header (these are plain `fetch()`
 * calls, unlike the WebSocket endpoints where only a query param works).
 */

import { useCallback, useEffect, useState } from "react";
import { proxyBase } from "./proxy-url";

export type BookmarkKind = "direct" | "wireless";

export interface Bookmark {
  id: string;
  name: string;
  /** `direct` reconnects via `/connect` (adbd TCP); `wireless` drives the
   *  ADB server's `wireless.connect` through the relay. */
  kind: BookmarkKind;
  host: string;
  port: number;
  lastConnected?: string;
}

interface BookmarksDoc {
  version: number;
  bookmarks: Bookmark[];
}

/** The proxy answered 404: BOOKMARKS_PATH is unset (or the proxy predates the
 *  feature). The UI hides the favorites panel rather than erroring. */
export class BookmarksUnavailableError extends Error {}

/** The bookmarks API lives on the same server as the WebSocket endpoints, so
 *  the base URL is the proxy URL with ws(s):// swapped for http(s)://. */
function httpBase(proxyUrl: string): string {
  return proxyBase(proxyUrl).replace(/^ws(s?):/i, "http$1:");
}

async function request(proxyUrl: string, token: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${httpBase(proxyUrl)}/bookmarks`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (response.status === 404) {
    throw new BookmarksUnavailableError(
      "This proxy has no bookmark storage (BOOKMARKS_PATH is unset).",
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Bookmarks request failed (${response.status}): ${detail.trim()}`);
  }
  return response;
}

function isBookmark(value: unknown): value is Bookmark {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<Bookmark>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    (candidate.kind === "direct" || candidate.kind === "wireless") &&
    typeof candidate.host === "string" &&
    typeof candidate.port === "number"
  );
}

export async function fetchBookmarks(proxyUrl: string, token: string): Promise<Bookmark[]> {
  const response = await request(proxyUrl, token);
  const doc = (await response.json().catch(() => null)) as Partial<BookmarksDoc> | null;
  if (!doc || !Array.isArray(doc.bookmarks)) {
    return [];
  }
  // Drop malformed entries instead of failing the whole list; the next save
  // rewrites the document in the current shape.
  return doc.bookmarks.filter(isBookmark);
}

export async function saveBookmarks(
  proxyUrl: string,
  token: string,
  bookmarks: Bookmark[],
): Promise<void> {
  await request(proxyUrl, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, bookmarks } satisfies BookmarksDoc),
  });
}

export function newBookmarkId(): string {
  // randomUUID needs a secure context, which the app already requires
  // (WebUSB/wss); the fallback covers plain-http LAN dev setups.
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---- React store ------------------------------------------------------------

export interface BookmarksState {
  /** `idle` = no proxy/token configured yet; `unavailable` = proxy has no
   *  bookmark storage. The favorites UI is hidden in both. */
  status: "idle" | "ready" | "unavailable" | "error";
  bookmarks: Bookmark[];
  error?: string;
}

export interface BookmarksStore {
  state: BookmarksState;
  /** Whether the favorites UI should exist at all (also true on errors, so
   *  they stay visible). */
  available: boolean;
  /** Insert, or update the name of an existing entry with the same
   *  kind/host/port, and persist. */
  save: (entry: Omit<Bookmark, "id" | "lastConnected">) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  /** Bump lastConnected; persisted best-effort (cosmetic on failure). */
  touch: (id: string) => void;
}

export function useBookmarks(proxyUrl: string, token: string): BookmarksStore {
  const [state, setState] = useState<BookmarksState>({ status: "idle", bookmarks: [] });

  useEffect(() => {
    if (!proxyUrl || !token) {
      setState({ status: "idle", bookmarks: [] });
      return;
    }
    let stale = false;
    // Debounced so a half-typed token doesn't spam the proxy with 401s.
    const timer = window.setTimeout(() => {
      fetchBookmarks(proxyUrl, token)
        .then((bookmarks) => {
          if (!stale) setState({ status: "ready", bookmarks });
        })
        .catch((e) => {
          if (stale) return;
          if (e instanceof BookmarksUnavailableError) {
            setState({ status: "unavailable", bookmarks: [] });
          } else {
            setState({
              status: "error",
              bookmarks: [],
              error: e instanceof Error ? e.message : String(e),
            });
          }
        });
    }, 400);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [proxyUrl, token]);

  // Optimistic: show the new list immediately, surface an error (keeping the
  // list) if the PUT fails.
  const persist = useCallback(
    (bookmarks: Bookmark[]) => {
      setState({ status: "ready", bookmarks });
      saveBookmarks(proxyUrl, token, bookmarks).catch((e) => {
        setState({
          status: "error",
          bookmarks,
          error: `Saving failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
    },
    [proxyUrl, token],
  );

  const save = useCallback(
    (entry: Omit<Bookmark, "id" | "lastConnected">) => {
      const existing = state.bookmarks.find(
        (b) => b.kind === entry.kind && b.host === entry.host && b.port === entry.port,
      );
      persist(
        existing
          ? state.bookmarks.map((b) => (b.id === existing.id ? { ...b, name: entry.name } : b))
          : [...state.bookmarks, { ...entry, id: newBookmarkId() }],
      );
    },
    [state.bookmarks, persist],
  );

  const rename = useCallback(
    (id: string, name: string) =>
      persist(state.bookmarks.map((b) => (b.id === id ? { ...b, name } : b))),
    [state.bookmarks, persist],
  );

  const remove = useCallback(
    (id: string) => persist(state.bookmarks.filter((b) => b.id !== id)),
    [state.bookmarks, persist],
  );

  const touch = useCallback(
    (id: string) => {
      const next = state.bookmarks.map((b) =>
        b.id === id ? { ...b, lastConnected: new Date().toISOString() } : b,
      );
      setState((prev) => ({ ...prev, bookmarks: next }));
      saveBookmarks(proxyUrl, token, next).catch(() => {});
    },
    [state.bookmarks, proxyUrl, token],
  );

  const available = state.status === "ready" || state.status === "error";
  return { state, available, save, rename, remove, touch };
}
