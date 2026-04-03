import { describe, expect, it } from "vitest";
import {
  bumpErrorEntry,
  cleanupRetainedJobArtifacts,
  getExampleTransaction,
  findErrorEntryByTxHash,
  getErrorEntry,
  normalizeErrorEntry,
  storeErrorEntry,
  storeTxHashPointer,
} from "../src/storage.js";
import { createTestEnv, MemoryR2Bucket } from "./helpers.js";

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

  it("writes tx hash pointers to KV for direct tx-hash lookup", async () => {
    const bucket = new MemoryR2Bucket();
    const env = createTestEnv(bucket);

    await storeErrorEntry(env, baseEntry);
    expect(await findErrorEntryByTxHash(env, "tx-old")).toBeNull();

    await storeTxHashPointer(env, "tx-old", "fp-1");
    await expect(env.CURSOR_KV.get("tx:tx-old")).resolves.toBe("fp-1");

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

  it("reads reference transactions from the durable prefix", async () => {
    const bucket = new MemoryR2Bucket();
    const env = createTestEnv(bucket);

    await bucket.put(
      "reference-transactions/fp-new.json",
      JSON.stringify({ fingerprint: "fp-new", transaction: { txHash: "tx-new" }, contracts: [], storedAt: "now" }),
    );

    await expect(getExampleTransaction(env, "fp-new")).resolves.toMatchObject({
      fingerprint: "fp-new",
    });
    await expect(getExampleTransaction(env, "fp-old")).resolves.toBeNull();
  });

  it("removes retained terminal job artifacts from the workflow bucket", async () => {
    const env = createTestEnv();

    await env.WORKFLOW_ARTIFACTS_BUCKET.put(
      "jobs/job-1.json",
      JSON.stringify({
        jobId: "job-1",
        kind: "ledger_batch",
        status: "completed",
        phase: "completed",
        createdAt: "2026-04-02T00:00:00.000Z",
        updatedAt: "2026-04-02T00:00:00.000Z",
        progress: { completed: 1, total: 1, unit: "steps" },
      }),
    );
    await env.WORKFLOW_ARTIFACTS_BUCKET.put("job-results/job-1.json", JSON.stringify({ ok: true }));
    await env.WORKFLOW_ARTIFACTS_BUCKET.put("job-inputs/job-1.json", JSON.stringify({ ok: true }));
    await env.WORKFLOW_ARTIFACTS_BUCKET.put("job-staging/job-1/step-results/a.json", JSON.stringify({ ok: true }));

    const summary = await cleanupRetainedJobArtifacts(env, 1);

    expect(summary.deletedJobs).toBe(1);
    expect(env.WORKFLOW_ARTIFACTS_BUCKET.getJson("jobs/job-1.json")).toBeNull();
    expect(env.WORKFLOW_ARTIFACTS_BUCKET.getJson("job-results/job-1.json")).toBeNull();
    expect(env.WORKFLOW_ARTIFACTS_BUCKET.getJson("job-inputs/job-1.json")).toBeNull();
    expect(env.WORKFLOW_ARTIFACTS_BUCKET.getJson("job-staging/job-1/step-results/a.json")).toBeNull();
  });
});
