import { describe, expect, it, vi } from "vitest";

vi.mock("../src/fingerprint.js", () => ({
  buildFingerprint: async () => ({
    fingerprint: "fp",
    functionName: "fn",
    errorSignatures: [],
  }),
}));

describe("job sanitization", () => {
  it("removes forwarded payload mirrors from both processingJson and decoded views", async () => {
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
        diagnosticEvents: [],
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
          diagnosticEvents: [],
          envelopeOperations: [],
          processingOperations: [],
          ledgerChanges: [],
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
    expect(sanitized?.transaction.processingJson).toEqual({
      result: {
        result: {
          tx_bad_auth: {
            status: "ERROR",
          },
        },
      },
    });
    expect(sanitized?.transaction.decoded).toEqual({
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
      decodedProcessing: {
        nested: {},
      },
    });
  });
});
