import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { createTestEnv, MemoryR2Bucket } from "./helpers.js";

vi.mock("../src/xdr.js", () => ({
  decodeXdrStream: vi.fn(() => []),
}));

function makeContractId(): string {
  return StrKey.encodeContract(
    Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
  );
}

describe("contracts cache", () => {
  beforeEach(async () => {
    const {
      resetContractCacheForTests,
    } = await import("../src/contracts.js");
    resetContractCacheForTests();
    vi.restoreAllMocks();
    (globalThis as { caches?: unknown }).caches = {
      default: {
        match: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  it("does not reread a stale R2 contract entry in the same invocation", async () => {
    const {
      getCachedContract,
    } = await import("../src/contracts.js");
    const bucket = new MemoryR2Bucket();
    const env = createTestEnv(bucket);
    const contractId = makeContractId();

    await bucket.put(
      `contracts/${contractId}.json`,
      JSON.stringify({
        contractId,
        wasmHash: "abc",
        functions: [],
        errorEnums: [],
        structs: [],
        fetchedAt: "2025-01-01T00:00:00.000Z",
      }),
    );

    const first = await getCachedContract(env, contractId);
    const second = await getCachedContract(env, contractId);

    expect(first).toEqual({ hit: false });
    expect(second).toEqual({ hit: false });
    expect(
      bucket.getCalls.filter((key) => key === `contracts/${contractId}.json`),
    ).toHaveLength(1);
  });

  it("negative-caches an on-chain miss and avoids a second fetch", async () => {
    const {
      fetchContractMetadata,
    } = await import("../src/contracts.js");
    const bucket = new MemoryR2Bucket();
    const env = createTestEnv(bucket);
    const contractId = makeContractId();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            result: { entries: [] },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const first = await fetchContractMetadata(env, contractId);
    const second = await fetchContractMetadata(env, contractId);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
