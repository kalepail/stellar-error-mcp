import { describe, expect, it } from "vitest";
import {
  bumpErrorEntry,
  findErrorEntryByTxHash,
  getErrorEntry,
  normalizeErrorEntry,
  storeErrorEntry,
  storeTxHashPointer,
} from "../src/storage.js";
import { createTestEnv, MemoryKV, MemoryR2Bucket } from "./helpers.js";

const baseEntry = {
  fingerprint: "fp-1",
  observationKinds: ["ledger_scan"] as const,
  contractIds: ["CAAAAA"],
  functionName: "transfer",
  errorSignatures: [{ type: "contract", code: "8" }],
  resultKind: "tx_failed",
  sorobanOperationTypes: ["invoke_host_function"],
  summary: "Transfer failed because the contract rejected the amount.",
  errorCategory: "contract:Error::InsufficientBalance",
  likelyCause: "The source balance was below the transfer amount.",
  suggestedFix: "Check the source balance before submitting the transfer.",
  detailedAnalysis:
    "The contract emitted a balance-related error before any state change completed.",
  evidence: ["Contract error code 8 was emitted."],
  relatedCodes: ["Error::InsufficientBalance"],
  debugSteps: ["Inspect the balance argument.", "Replay against a funded account."],
  confidence: "high" as const,
  modelId: "model",
  seenCount: 1,
  txHashes: ["tx-old"],
  firstSeen: "2026-04-01T00:00:00.000Z",
  lastSeen: "2026-04-01T00:00:00.000Z",
  exampleTxHash: "tx-old",
  exampleReadout: {
    observationKind: "ledger_scan" as const,
    resultKind: "tx_failed",
    feeBump: false,
    invokeCallCount: 1,
    contractCount: 1,
    hasSorobanMeta: true,
    hasEvents: true,
    hasDiagnosticEvents: true,
  },
  contractContext: "transfer(amount: i128)",
};

describe("storage", () => {
  it("stores the canonical error entry and a dedicated search document", async () => {
    const bucket = new MemoryR2Bucket();
    const env = createTestEnv(bucket);

    await storeErrorEntry(env, baseEntry);

    expect(bucket.getJson("errors/fp-1.json")).toMatchObject({
      fingerprint: "fp-1",
      errorCategory: "contract:Error::InsufficientBalance",
    });

    expect(await bucket.get("search-docs/fp-1.md")).not.toBeNull();
    const searchDoc = await bucket.get("search-docs/fp-1.md");
    expect(await searchDoc?.text()).toContain("# Transfer failed because the contract rejected the amount.");
    expect(await searchDoc?.text()).toContain("Primary contract: CAAAAA");

    const metadata = bucket.getPutOptions("search-docs/fp-1.md")?.customMetadata;
    expect(metadata).toEqual({
      fingerprint: "fp-1",
      error_category: "contract:Error::InsufficientBalance",
      function_name: "transfer",
      primary_contract: "CAAAAA",
      operation_type: "invoke_host_function",
    });
  });

  it("keeps tx hashes bounded and refreshes the search document on bump", async () => {
    const bucket = new MemoryR2Bucket();
    const env = createTestEnv(bucket);

    await storeErrorEntry(env, {
      ...baseEntry,
      txHashes: Array.from({ length: 50 }, (_value, index) => `tx-${index}`),
      exampleTxHash: "tx-49",
    });

    const entry = await getErrorEntry(env, "fp-1");
    await bumpErrorEntry(
      env,
      entry!,
      "tx-new",
      "2026-04-02T00:00:00.000Z",
      "rpc_send",
    );

    const stored = bucket.getJson("errors/fp-1.json") as { txHashes: string[]; seenCount: number };
    expect(stored.txHashes).toHaveLength(50);
    expect(stored.txHashes.at(-1)).toBe("tx-new");
    expect(stored.seenCount).toBe(2);
    expect((stored as { observationKinds: string[] }).observationKinds).toEqual([
      "ledger_scan",
      "rpc_send",
    ]);

    const searchDoc = await bucket.get("search-docs/fp-1.md");
    expect(await searchDoc?.text()).toContain("Occurrences: 2");
    expect(await searchDoc?.text()).toContain("Last seen: 2026-04-02T00:00:00.000Z");
  });

  it("resolves tx hashes through KV pointer index, not R2", async () => {
    const bucket = new MemoryR2Bucket();
    const kv = new MemoryKV();
    const env = createTestEnv(bucket, kv);

    await storeErrorEntry(env, baseEntry);
    expect(await findErrorEntryByTxHash(env, "tx-old")).toBeNull();

    await storeTxHashPointer(env, "tx-old", "fp-1");

    // Verify pointer was written to KV, not R2
    expect(kv.store.get("tx:tx-old")).toBe("fp-1");
    expect(bucket.objects.has("tx-index/tx-old.json")).toBe(false);

    const found = await findErrorEntryByTxHash(env, "tx-old");
    expect(found?.fingerprint).toBe("fp-1");
    expect(bucket.listCalls).toHaveLength(0);
  });

  it("rejects malformed current-shape entries instead of repairing them", () => {
    expect(
      normalizeErrorEntry({
        fingerprint: "broken",
        summary: "Broken entry",
      }),
    ).toBeNull();
  });
});
