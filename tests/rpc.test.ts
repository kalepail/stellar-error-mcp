import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers.js";

describe("rpc helpers", () => {
  it("uses bearer auth by default for realtime RPC", async () => {
    const { rpcRequest, getRealtimeRpcEndpoint, getRpcAuthMode } = await import("../src/rpc.js");
    const env = createTestEnv();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: { sequence: 123 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await rpcRequest({
      endpoint: getRealtimeRpcEndpoint(env),
      token: env.STELLAR_ARCHIVE_RPC_TOKEN,
      authMode: getRpcAuthMode(env),
      method: "getLatestLedger",
    });

    expect(result.sequence).toBe(123);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rpc.example.com",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token",
        }),
      }),
    );
  });

  it("supports path authentication when configured", async () => {
    const { buildRpcUrl } = await import("../src/rpc.js");
    expect(buildRpcUrl("https://rpc-pro.lightsail.network/", "abc123", "path")).toBe(
      "https://rpc-pro.lightsail.network/abc123",
    );
  });
});
