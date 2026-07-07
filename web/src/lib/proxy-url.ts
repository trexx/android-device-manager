/** Normalize a user-entered proxy URL into a base with no trailing slash.
 *  Shared by the WebSocket URL builders and the bookmarks HTTP client. */
export function proxyBase(proxyUrl: string): string {
  return proxyUrl.trim().replace(/\/+$/, "");
}
