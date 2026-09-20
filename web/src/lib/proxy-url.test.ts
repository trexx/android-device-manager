import { describe, expect, it } from "vitest";
import { proxyBase, tokenProtocol } from "./proxy-url";

describe("proxyBase", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(proxyBase("  wss://proxy.example///  ")).toBe("wss://proxy.example");
    expect(proxyBase("ws://localhost:8080")).toBe("ws://localhost:8080");
  });
});

describe("tokenProtocol", () => {
  it("hex-encodes the token's UTF-8 bytes behind a fixed prefix", () => {
    // Must match the proxy's `token_protocol("secret")` test.
    expect(tokenProtocol("secret")).toBe("adm-token-736563726574");
    expect(tokenProtocol("")).toBe("adm-token-");
    expect(tokenProtocol("\u00e9")).toBe("adm-token-c3a9");
  });

  it("only ever produces RFC 6455 token characters", () => {
    expect(tokenProtocol("sp ace/=+;,\"")).toMatch(/^[A-Za-z0-9-]+$/);
  });
});
