import { beforeEach, describe, expect, it, vi } from "vitest";
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { createTestEnv, MemoryR2Bucket } from "./helpers.js";

vi.mock("../src/xdr.js", () => ({
  decodeXdrStream: vi.fn(() => []),
}));

function makeContractId(): string {
  return StrKey.encodeContract(
    Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
  );
}

function makeSacInstanceEntryXdr(contractId: string): string {
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
    storage: [
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("METADATA"),
        val: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("decimal"),
            val: xdr.ScVal.scvU32(7),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("name"),
            val: xdr.ScVal.scvString("native"),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("symbol"),
            val: xdr.ScVal.scvString("native"),
          }),
        ]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("AssetInfo")]),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Native")]),
      }),
    ],
  });

  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(instance),
      ext: new xdr.ExtensionPoint(0),
    }),
  ).toXDR("base64");
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
      `contracts/endpoint:rpc_example_com/${contractId}.json`,
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
      bucket.getCalls.filter((key) => key === `contracts/endpoint:rpc_example_com/${contractId}.json`),
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

  it("returns synthetic metadata for Stellar Asset Contract executables", async () => {
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
            result: {
              entries: [{ xdr: makeSacInstanceEntryXdr(contractId) }],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const meta = await fetchContractMetadata(env, contractId);

    expect(meta).toMatchObject({
      contractId,
      wasmHash: "stellar_asset",
      contractType: "stellar_asset",
      builtin: {
        kind: "stellar_asset_contract",
        name: "Stellar Asset Contract",
      },
      structs: [],
      assetMetadata: {
        decimal: 7,
        name: "native",
        symbol: "native",
        AssetInfo: ["Native"],
      },
    });
    expect(meta?.functions.map((fn) => fn.name)).toEqual(
      expect.arrayContaining(["transfer", "transfer_from", "mint", "trust"]),
    );
    expect(meta?.errorEnums[0]?.name).toBe("ContractError");
    expect(meta?.errorEnums[0]?.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "TrustlineMissingError", value: 13 }),
        expect.objectContaining({ name: "AuthenticationError", value: 5 }),
      ]),
    );
    expect(meta?.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Detected from contractExecutableStellarAsset"),
        "Built-in Stellar Asset Contract executable",
        "AssetInfo: Native",
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes multiline contract docs before building context", async () => {
    const {
      buildContractContext,
    } = await import("../src/contracts.js");

    const context = buildContractContext(new Map([
      [makeContractId(), {
        contractId: makeContractId(),
        wasmHash: "abc",
        functions: [{
          name: "transfer",
          doc: "  First line.\nSecond line.\n\nThird line with extra spacing.  ",
          inputs: [{ name: "to", type: "Address" }],
          outputs: ["Result"],
        }],
        errorEnums: [{
          name: "Error",
          cases: [{
            name: "BadInput",
            value: 1,
            doc: "line one\nline two",
          }],
        }],
        structs: [],
        fetchedAt: "2026-04-02T00:00:00.000Z",
      }],
    ]));

    expect(context).toContain("/// First line. Second line. Third line with extra spacing.");
    expect(context).toContain("1 = BadInput  // line one line two");
    expect(context).not.toContain("\nSecond line.");
    expect(context).not.toContain("line one\nline two");
  });

  it("renders Stellar Asset Contract context details", async () => {
    const {
      buildContractContext,
    } = await import("../src/contracts.js");

    const contractId = makeContractId();
    const context = buildContractContext(new Map([
      [contractId, {
        contractId,
        wasmHash: "stellar_asset",
        contractType: "stellar_asset",
        builtin: {
          kind: "stellar_asset_contract",
          name: "Stellar Asset Contract",
          summary: "Built-in token contract for Stellar assets.",
          sourceRefs: [
            {
              label: "SAC Host Implementation",
              url: "https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/builtin_contracts/stellar_asset_contract/contract.rs",
            },
          ],
          authSemantics: ["Getters require no authorization."],
          failureModes: ["Missing trustlines on classic accounts map to TrustlineMissingError."],
        },
        functions: [],
        errorEnums: [],
        structs: [],
        notes: [
          "Built-in Stellar Asset Contract executable",
          "AssetInfo: Native",
        ],
        assetMetadata: {
          decimal: 7,
          name: "native",
          symbol: "native",
        },
        fetchedAt: "2026-04-07T00:00:00.000Z",
      }],
    ]));

    expect(context).toContain("Contract Type: stellar_asset");
    expect(context).toContain("Built-in: Stellar Asset Contract");
    expect(context).toContain("Built-in Summary:");
    expect(context).toContain("Built-in Sources:");
    expect(context).toContain("Built-in Auth Semantics:");
    expect(context).toContain("Built-in Failure Modes:");
    expect(context).toContain("Notes:");
    expect(context).toContain("Built-in Stellar Asset Contract executable");
    expect(context).toContain("Asset Metadata:");
    expect(context).toContain("decimal: 7");
    expect(context).toContain("name: native");
    expect(context).toContain("symbol: native");
  });
});
