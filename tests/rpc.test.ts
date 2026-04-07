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

  it("resolves testnet-specific endpoints and auth mode from transaction context", async () => {
    const { resolveRpcConfig } = await import("../src/rpc.js");
    const env = createTestEnv();

    expect(resolveRpcConfig(env, { network: "testnet" })).toMatchObject({
      rpcEndpoint: "https://rpc-testnet.example.com",
      archiveRpcEndpoint: "https://archive-rpc-testnet.example.com",
      token: "testnet-token",
      authMode: "path",
      scope: "network:testnet",
    });
  });

  it("keeps explicit mainnet context scoped separately from endpoint-derived defaults", async () => {
    const { resolveRpcConfig } = await import("../src/rpc.js");
    const env = createTestEnv();

    expect(resolveRpcConfig(env, { network: "mainnet" })).toMatchObject({
      rpcEndpoint: "https://rpc.example.com",
      archiveRpcEndpoint: "https://archive-rpc.example.com",
      token: "token",
      authMode: "header",
      scope: "network:mainnet",
    });
  });

  it("omits auth when using explicit testnet endpoints without a testnet token", async () => {
    const { resolveRpcConfig, rpcRequest } = await import("../src/rpc.js");
    const env = createTestEnv();
    env.STELLAR_TESTNET_RPC_TOKEN = undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: { sequence: 123 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const config = resolveRpcConfig(env, {
      network: "testnet",
      rpcEndpoint: "https://public-testnet.example.com",
    });
    await rpcRequest({
      endpoint: config.rpcEndpoint,
      token: config.token,
      authMode: config.authMode,
      method: "getLatestLedger",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://public-testnet.example.com",
      expect.objectContaining({
        headers: expect.not.objectContaining({
          Authorization: expect.anything(),
        }),
      }),
    );
  });

  it("fails over across testnet providers and remembers the last successful one", async () => {
    const { rpcRequestWithEnv } = await import("../src/rpc.js");
    const env = createTestEnv();
    env.STELLAR_TESTNET_RPC_TOKEN = undefined;
    env.STELLAR_TESTNET_RPC_ENDPOINT = undefined;
    env.STELLAR_TESTNET_ARCHIVE_RPC_ENDPOINT = undefined;

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { sequence: 321 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { sequence: 322 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const first = await rpcRequestWithEnv(env, {
      method: "getLatestLedger",
    }, { network: "testnet" });
    expect(first.sequence).toBe(321);

    const second = await rpcRequestWithEnv(env, {
      method: "getLatestLedger",
    }, { network: "testnet" });
    expect(second.sequence).toBe(322);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://stellar-soroban-testnet-public.nodies.app");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://soroban-rpc.testnet.stellar.gateway.fm");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://soroban-rpc.testnet.stellar.gateway.fm");
    await expect(env.CURSOR_KV.get("rpc:testnet:last_success_endpoint")).resolves.toBe(
      "https://soroban-rpc.testnet.stellar.gateway.fm",
    );
  });

  it("requires explicit endpoints for custom networks instead of falling back to mainnet", async () => {
    const { resolveRpcConfig } = await import("../src/rpc.js");
    const env = createTestEnv();

    expect(() => resolveRpcConfig(env, { network: "custom" })).toThrow(
      "network 'custom' requires an explicit rpcEndpoint",
    );
    expect(() => resolveRpcConfig(env, { network: "futurenet" })).toThrow(
      "network 'futurenet' requires an explicit rpcEndpoint",
    );
  });

  it("scopes custom and futurenet RPC caches by endpoint", async () => {
    const { resolveRpcConfig } = await import("../src/rpc.js");
    const env = createTestEnv();

    expect(resolveRpcConfig(env, {
      network: "custom",
      rpcEndpoint: "https://custom-a.example.com/rpc",
    }).scope).toBe("network:custom:endpoint:custom_a_example_com_rpc");

    expect(resolveRpcConfig(env, {
      network: "custom",
      rpcEndpoint: "https://custom-b.example.com/rpc",
    }).scope).toBe("network:custom:endpoint:custom_b_example_com_rpc");

    expect(resolveRpcConfig(env, {
      network: "futurenet",
      rpcEndpoint: "https://future.example.com",
      archiveRpcEndpoint: "https://archive.future.example.com",
    }).scope).toBe("network:futurenet:endpoint:archive_future_example_com");
  });
});
