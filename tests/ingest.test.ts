import { describe, expect, it, vi } from "vitest";
import { createTestEnv, MemoryR2Bucket } from "./helpers.js";
import { ingestFailedTransaction } from "../src/ingest.js";
import { getErrorEntry } from "../src/storage.js";
import type { FailedTransaction } from "../src/types.js";

vi.mock("../src/analysis.js", () => ({
  analyzeFailedTransaction: async () => ({
    txHash: "tx-1",
    summary: "summary",
    errorCategory: "category",
    likelyCause: "cause",
    suggestedFix: "fix",
    detailedAnalysis: "details",
    evidence: [],
    relatedCodes: [],
    debugSteps: [],
    confidence: "medium",
    analyzedAt: "2026-04-02T00:00:00.000Z",
    modelId: "model",
  }),
}));

vi.mock("../src/contracts.js", () => ({
  fetchContractsForError: async () => new Map(),
  buildContractContext: () => undefined,
}));

vi.mock("../src/transaction.js", () => ({
  attachDeepDecodedViews: (decoded: unknown) => decoded,
  extractErrorSignatures: () => [],
  extractFunctionName: () => "transfer",
}));

function createFailedTx(txHash: string): FailedTransaction {
  return {
    observationKind: "rpc_send",
    txHash,
    ledgerSequence: 1,
    ledgerCloseTime: "2026-04-02T00:00:00.000Z",
    resultKind: "tx_bad_seq",
    soroban: true,
    primaryContractIds: ["C1"],
    contractIds: ["C1"],
    operationTypes: ["invoke_host_function"],
    sorobanOperationTypes: ["invoke_host_function"],
    diagnosticEvents: [],
    envelopeJson: {},
    processingJson: {},
    decoded: {
      topLevelFunction: "transfer",
      errorSignatures: [{ type: "result", code: "tx_bad_seq" }],
      invokeCalls: [],
      authEntries: [],
      resourceLimits: null,
      transactionResult: null,
      sorobanMeta: null,
      contractEvents: [],
      diagnosticEvents: [],
      envelopeOperations: [],
      processingOperations: [],
      ledgerChanges: [],
      touchedContractIds: [],
    },
    readout: {
      observationKind: "rpc_send",
      resultKind: "tx_bad_seq",
      feeBump: false,
      invokeCallCount: 0,
      contractCount: 1,
      hasSorobanMeta: false,
      hasEvents: false,
      hasDiagnosticEvents: false,
    },
  };
}

describe("ingest idempotency", () => {
  it("does not bump seenCount when the same tx hash is retried", async () => {
    const env = createTestEnv();
    const tx = createFailedTx("tx-1");

    const first = await ingestFailedTransaction(env, tx);
    const second = await ingestFailedTransaction(env, tx);

    expect(first.status).toBe("new");
    expect(second.status).toBe("duplicate");

    const stored = await getErrorEntry(env, first.fingerprint);
    expect(stored?.seenCount).toBe(1);
    expect(stored?.txHashes).toEqual(["tx-1"]);
  });

  it("forceReanalyze refreshes an existing error without bumping seenCount", async () => {
    const env = createTestEnv();
    const tx = createFailedTx("tx-1");

    const first = await ingestFailedTransaction(env, tx);
    const second = await ingestFailedTransaction(env, tx, { forceReanalyze: true });

    expect(first.status).toBe("new");
    expect(second.status).toBe("new");

    const stored = await getErrorEntry(env, first.fingerprint);
    expect(stored?.seenCount).toBe(1);
    expect(stored?.txHashes).toEqual(["tx-1"]);
  });

  it("rolls back the stored example if the canonical error write fails", async () => {
    class FailingErrorsBucket extends MemoryR2Bucket {
      override async put(key: string, value: string, options?: R2PutOptions): Promise<void> {
        if (key.startsWith("errors/")) {
          throw new Error("simulated write failure");
        }
        await super.put(key, value, options);
      }
    }

    const bucket = new FailingErrorsBucket();
    const workflowBucket = createTestEnv().WORKFLOW_ARTIFACTS_BUCKET;
    const env = createTestEnv(bucket, workflowBucket);

    await expect(ingestFailedTransaction(env, createFailedTx("tx-rollback"))).rejects.toThrow(
      "simulated write failure",
    );

    expect(
      [...bucket.objects.keys()].filter((key) => key.startsWith("reference-transactions/")),
    ).toEqual([]);
    expect(
      [...bucket.objects.keys()].filter((key) => key.startsWith("errors/")),
    ).toEqual([]);
  });
});
