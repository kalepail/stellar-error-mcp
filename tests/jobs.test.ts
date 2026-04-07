import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers.js";
import { storeErrorEntry, storeTxHashPointer } from "../src/storage.js";

const buildFailedTransactionFromDirectError = vi.fn();

vi.mock("../src/direct.js", () => ({
  buildFailedTransactionFromDirectError,
}));

vi.mock("../src/fingerprint.js", () => ({
  buildFingerprint: async () => ({
    fingerprint: "fp",
    functionName: "fn",
    errorSignatures: [],
  }),
}));

describe("job sanitization", () => {
  it("builds a compact public transaction preview instead of returning raw decoded payloads", async () => {
    const { sanitizeExampleTransaction } = await import("../src/jobs.js");
    const sanitized = sanitizeExampleTransaction({
      fingerprint: "fp-1",
      storedAt: "2026-04-03T00:00:00.000Z",
      transaction: {
        observationKind: "rpc_send",
        txHash: "tx-1",
        ledgerSequence: 1,
        ledgerCloseTime: "2026-04-03T00:00:00.000Z",
        resultKind: "tx_bad_auth",
        soroban: true,
        primaryContractIds: [],
        contractIds: [],
        operationTypes: ["invoke_host_function"],
        sorobanOperationTypes: ["invoke_host_function"],
        diagnosticEvents: [{ type: "diagnostic", nested: { sourcePayload: { foo: "bar" } } }],
        envelopeJson: {},
        processingJson: {
          result: {
            result: {
              tx_bad_auth: {
                status: "ERROR",
              },
            },
          },
          direct: {
            response: {
              secret: "remove-me",
            },
          },
        },
        decoded: {
          topLevelFunction: "transfer",
          errorSignatures: [],
          invokeCalls: [],
          authEntries: [],
          resourceLimits: null,
          transactionResult: null,
          sorobanMeta: null,
          contractEvents: [],
          diagnosticEvents: [{ type: "diagnostic", message: "boom" }],
          envelopeOperations: [],
          processingOperations: [{ index: 0 }],
          ledgerChanges: [{ operationIndex: 0 }],
          touchedContractIds: [],
          decodedProcessing: {
            nested: {
              direct: {
                response: {
                  secret: "remove-me-too",
                },
              },
              sourcePayload: {
                submission: "remove-me-three",
              },
            },
          },
        },
        readout: {
          observationKind: "rpc_send",
          resultKind: "tx_bad_auth",
          feeBump: false,
          invokeCallCount: 0,
          contractCount: 0,
          hasSorobanMeta: false,
          hasEvents: false,
          hasDiagnosticEvents: false,
        },
        sourcePayload: {
          response: {
            secret: "remove-me-four",
          },
        },
      },
      contracts: [],
    });

    expect(sanitized?.transaction).not.toHaveProperty("sourcePayload");
    expect(sanitized?.transaction).not.toHaveProperty("processingJson");
    expect(sanitized?.transaction).not.toHaveProperty("envelopeJson");
    expect(sanitized?.transaction.decoded).toEqual({
      topLevelFunction: "transfer",
      errorSignatures: [],
      invokeCalls: [],
      authEntryCount: 0,
      authEntryPreview: [],
      resourceLimits: null,
      transactionResult: null,
      contractEvents: {
        count: 0,
        preview: [],
      },
      diagnosticEvents: {
        count: 1,
        preview: [{ type: "diagnostic", message: "boom" }],
      },
      processingOperationCount: 1,
      ledgerChangeCount: 1,
      touchedContractIds: [],
    });
  });
});

describe("direct preflight", () => {
  it("bypasses duplicate short-circuiting when forceReanalyze is set", async () => {
    const env = createTestEnv();
    buildFailedTransactionFromDirectError.mockResolvedValue({
      observationKind: "rpc_simulate",
      txHash: "tx-force",
      ledgerSequence: 1,
      ledgerCloseTime: "2026-04-03T00:00:00.000Z",
      resultKind: "simulate:hosterror",
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
        observationKind: "rpc_simulate",
        resultKind: "simulate:hosterror",
        feeBump: false,
        invokeCallCount: 0,
        contractCount: 1,
        hasSorobanMeta: false,
        hasEvents: false,
        hasDiagnosticEvents: false,
        sourceReference: "rpcsim-force",
      },
    });

    await storeErrorEntry(env, {
      fingerprint: "fp",
      observationKinds: ["rpc_simulate"],
      contractIds: ["C1"],
      functionName: "transfer",
      errorSignatures: [],
      resultKind: "simulate:hosterror",
      sorobanOperationTypes: ["invoke_host_function"],
      summary: "old summary",
      errorCategory: "category",
      likelyCause: "cause",
      suggestedFix: "fix",
      detailedAnalysis: "details",
      evidence: [],
      relatedCodes: [],
      debugSteps: [],
      confidence: "medium",
      modelId: "model",
      seenCount: 1,
      txHashes: ["tx-force"],
      firstSeen: "2026-04-03T00:00:00.000Z",
      lastSeen: "2026-04-03T00:00:00.000Z",
      exampleTxHash: "tx-force",
      exampleReadout: {
        observationKind: "rpc_simulate",
        resultKind: "simulate:hosterror",
        feeBump: false,
        invokeCallCount: 0,
        contractCount: 1,
        hasSorobanMeta: false,
        hasEvents: false,
        hasDiagnosticEvents: false,
      },
    });
    await storeTxHashPointer(env, "tx-force", "fp");

    const { preflightDirectErrorSubmission } = await import("../src/jobs.js");
    const result = await preflightDirectErrorSubmission(env, {
      kind: "rpc_simulate",
      transactionXdr: "AAAA",
      response: { error: "boom" },
      forceReanalyze: true,
    });

    expect(result).toMatchObject({
      duplicate: false,
      fingerprint: "fp",
      sourceReference: "rpcsim-force",
      forceReanalyze: true,
    });
  });
});
