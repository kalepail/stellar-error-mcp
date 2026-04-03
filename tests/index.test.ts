import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers.js";

const storeDirectErrorJob = vi.fn(async () => undefined);
const getDirectErrorJob = vi.fn(async () => null);

vi.mock("../src/mcp.js", () => ({
  createMcpFetchHandler: async () => () => new Response("mock mcp"),
}));

vi.mock("../src/stellar.js", () => ({
  getLatestLedger: async () => 123,
  scanForFailedTransactions: async () => ({
    transactions: [],
    lastLedgerProcessed: 123,
    pagesScanned: 0,
    ledgersScanned: 0,
  }),
}));

vi.mock("../src/storage.js", () => ({
  getLastProcessedLedger: async () => null,
  setLastProcessedLedger: async () => undefined,
  storeDirectErrorJob,
  getDirectErrorJob,
}));

vi.mock("../src/direct.js", () => ({
  parseDirectErrorSubmission: (value: unknown) => value,
  buildQueuedDirectErrorJob: (jobId: string, submission: { kind: string }) => ({
    jobId,
    status: "queued",
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
    kind: submission.kind,
  }),
  buildFailedTransactionFromDirectError: async () => ({
    observationKind: "rpc_send",
    txHash: "tx-1",
    ledgerSequence: 1,
    ledgerCloseTime: "2026-04-02T00:00:00.000Z",
    resultKind: "tx_bad_seq",
    soroban: true,
    primaryContractIds: [],
    contractIds: [],
    operationTypes: ["invoke_host_function"],
    sorobanOperationTypes: ["invoke_host_function"],
    diagnosticEvents: [],
    envelopeJson: {},
    processingJson: {},
    decoded: {
      topLevelFunction: "transfer",
      errorSignatures: [],
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
      contractCount: 0,
      hasSorobanMeta: false,
      hasEvents: false,
      hasDiagnosticEvents: false,
    },
  }),
}));

vi.mock("../src/ingest.js", () => ({
  ingestFailedTransaction: async () => ({
    status: "duplicate",
    fingerprint: "fp-1",
    entry: {
      fingerprint: "fp-1",
      observationKinds: ["rpc_send"],
      contractIds: [],
      functionName: "transfer",
      errorSignatures: [],
      resultKind: "tx_bad_seq",
      sorobanOperationTypes: ["invoke_host_function"],
      summary: "summary",
      errorCategory: "category",
      likelyCause: "cause",
      suggestedFix: "fix",
      detailedAnalysis: "details",
      evidence: [],
      relatedCodes: [],
      debugSteps: [],
      confidence: "low",
      modelId: "model",
      seenCount: 1,
      txHashes: ["tx-1"],
      firstSeen: "2026-04-02T00:00:00.000Z",
      lastSeen: "2026-04-02T00:00:00.000Z",
      exampleTxHash: "tx-1",
      exampleReadout: {
        observationKind: "rpc_send",
        resultKind: "tx_bad_seq",
        feeBump: false,
        invokeCallCount: 0,
        contractCount: 0,
        hasSorobanMeta: false,
        hasEvents: false,
        hasDiagnosticEvents: false,
      },
    },
    example: null,
  }),
}));

describe("worker fetch smoke", () => {
  beforeEach(() => {
    storeDirectErrorJob.mockClear();
    getDirectErrorJob.mockReset();
    getDirectErrorJob.mockResolvedValue(null);
  });

  it("serves a health document aligned with the v1 architecture", async () => {
    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("https://example.com/health"),
      createTestEnv(),
      {
        waitUntil: () => undefined,
      } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      service: "stellar-error-mcp",
      status: "ok",
      aiSearch: {
        instance: "search",
        searchablePrefix: "search-docs/",
      },
      endpoints: {
        mcp: "/mcp",
        trigger: "/trigger",
        batch: "/batch",
        forwardError: "/forward-error",
        jobStatus: "/jobs/:jobId",
        health: "/health",
      },
    });
  });

  it("accepts direct error submissions and returns a poll URL", async () => {
    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("http://localhost/forward-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "rpc_send",
          transactionXdr: "AAAA",
          response: { status: "ERROR" },
        }),
      }),
      createTestEnv(),
      {
        waitUntil: () => undefined,
      } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "accepted",
      pollUrl: expect.stringMatching(/^\/jobs\/job_/),
    });
    expect(storeDirectErrorJob).toHaveBeenCalled();
  });

  it("returns stored direct job state", async () => {
    getDirectErrorJob.mockResolvedValue({
      jobId: "job_123",
      status: "completed",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:01:00.000Z",
      kind: "rpc_send",
      result: {
        duplicate: true,
        fingerprint: "fp-1",
        entry: { fingerprint: "fp-1" },
        example: null,
      },
    });

    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("http://localhost/jobs/job_123"),
      createTestEnv(),
      {
        waitUntil: () => undefined,
      } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_123",
      status: "completed",
      result: {
        duplicate: true,
        fingerprint: "fp-1",
      },
    });
  });

  it("does not expose the removed ingest endpoint", async () => {
    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("https://example.com/ingest", { method: "POST" }),
      createTestEnv(),
      {
        waitUntil: () => undefined,
      } as ExecutionContext,
    );

    expect(response.status).toBe(404);
  });
});
