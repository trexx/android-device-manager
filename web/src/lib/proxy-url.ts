/** Normalize a user-entered proxy URL into a base with no trailing slash.
 *  Shared by the WebSocket URL builders and the bookmarks HTTP client. */
export function proxyBase(proxyUrl: string): string {
  return proxyUrl.trim().replace(/\/+$/, "");
}

/**
 * The WebSocket subprotocol that carries the proxy's AUTH_TOKEN. Browsers can't
 * set request headers on a WebSocket, but they can offer subprotocols; this
 * keeps the token out of the URL (and out of reverse-proxy access logs). The
 * token's UTF-8 bytes are hex-encoded so any token fits RFC 6455's token
 * charset; the proxy compares against the same encoding and selects it in the
 * upgrade response. Requires proxy >= 2.3.0.
 */
export function tokenProtocol(token: string): string {
  const hex = Array.from(new TextEncoder().encode(token), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `adm-token-${hex}`;
}
