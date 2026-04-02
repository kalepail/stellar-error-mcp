import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers.js";

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
  getErrorEntry: async () => null,
  storeErrorEntry: async () => undefined,
  bumpErrorEntry: async () => undefined,
  storeTxHashPointer: async () => undefined,
  storeExampleTransaction: async () => undefined,
  findSimilarError: async () => null,
  indexErrorVector: async () => undefined,
  getLastProcessedLedger: async () => null,
  setLastProcessedLedger: async () => undefined,
}));

vi.mock("../src/analysis.js", () => ({
  analyzeFailedTransaction: async () => ({
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
  }),
}));

vi.mock("../src/fingerprint.js", () => ({
  buildFingerprint: async () => ({
    fingerprint: "fp",
    functionName: "fn",
    errorSignatures: [],
  }),
  buildErrorDescription: () => "description",
}));

vi.mock("../src/contracts.js", () => ({
  fetchContractsForError: async () => new Map(),
  buildContractContext: () => "",
}));

vi.mock("../src/transaction.js", () => ({
  attachDeepDecodedViews: (decoded) => decoded,
}));

describe("worker fetch smoke", () => {
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
        health: "/health",
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
