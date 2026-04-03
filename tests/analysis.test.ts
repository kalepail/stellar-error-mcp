import { describe, expect, it, vi } from "vitest";
import { analyzeFailedTransaction } from "../src/analysis.js";
import { createTestEnv } from "./helpers.js";
import type { ContractMetadata, FailedTransaction } from "../src/types.js";

function createFailedTx(overrides: Partial<FailedTransaction> = {}): FailedTransaction {
  return {
    observationKind: "rpc_send",
    txHash: "tx-analysis-1",
    ledgerSequence: 123,
    ledgerCloseTime: "2026-04-03T12:00:00.000Z",
    resultKind: "tx_bad_auth",
    soroban: true,
    primaryContractIds: ["C1"],
    contractIds: ["C1", "C2"],
    operationTypes: ["invoke_host_function"],
    sorobanOperationTypes: ["invoke_host_function"],
    diagnosticEvents: [],
    envelopeJson: { envelope: { body: "small" } },
    processingJson: { result: { tx_bad_auth: true } },
    decoded: {
      topLevelFunction: "transfer",
      errorSignatures: [{ type: "auth", code: "invalid_action" }],
      invokeCalls: [{ contractId: "C1", functionName: "transfer", args: [1, 2] }],
      authEntries: [{ address: "GABC" }],
      resourceLimits: { instructions: 1000, readBytes: 100, writeBytes: 20 },
      transactionResult: { tx_bad_auth: {} },
      sorobanMeta: { events: [] },
      contractEvents: [{ type: "contract" }],
      diagnosticEvents: [{ type: "diagnostic" }],
      envelopeOperations: [{ body: { invoke_host_function: true } }],
      processingOperations: [{ index: 0, changeCount: 0, eventCount: 0, diagnosticEventCount: 1, touchedContractIds: ["C1"], changes: [], events: [], diagnosticEvents: [] }],
      ledgerChanges: [{ operationIndex: 0, contractIds: ["C1"], change: { after: "value" } }],
      touchedContractIds: ["C1", "C2"],
      decodedEnvelope: { decoded: { body: "small" } },
      decodedProcessing: { decoded: { processing: "small" } },
    },
    readout: {
      observationKind: "rpc_send",
      resultKind: "tx_bad_auth",
      feeBump: false,
      invokeCallCount: 1,
      contractCount: 2,
      hasSorobanMeta: true,
      hasEvents: true,
      hasDiagnosticEvents: true,
    },
    ...overrides,
  };
}

function createContractMetadata(): Map<string, ContractMetadata> {
  return new Map([
    [
      "C1",
      {
        contractId: "C1",
        wasmHash: "wasm-1",
        functions: [
          {
            name: "transfer",
            inputs: [
              { name: "from", type: "Address" },
              { name: "to", type: "Address" },
              { name: "amount", type: "i128" },
            ],
            outputs: ["void"],
          },
        ],
        errorEnums: [
          {
            name: "Error",
            cases: [{ name: "InsufficientBalance", value: 1 }],
          },
        ],
        structs: [{ name: "Transfer", fields: [{ name: "amount", type: "i128" }] }],
        customSections: {
          contractspecv0: [{ type: "spec" }],
          contractmetav0: [{ key: "doc", value: "metadata" }],
          contractenvmetav0: [{ key: "env", value: "testnet" }],
        },
        fetchedAt: "2026-04-03T12:00:00.000Z",
      },
    ],
  ]);
}

describe("analysis prompt building", () => {
  it("keeps full high-fidelity context when the prompt fits the budget", async () => {
    const env = createTestEnv();
    let capturedPrompt = "";
    env.AI = {
      run: vi.fn(async (_model, params: any) => {
        capturedPrompt = params.messages[1].content;
        return JSON.stringify({
          summary: "summary",
          errorCategory: "auth:invalid_action",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["tx_bad_auth"],
          debugSteps: ["step"],
          confidence: "high",
        });
      }),
    } as unknown as Ai;

    const result = await analyzeFailedTransaction(
      env,
      createFailedTx(),
      createContractMetadata(),
    );

    expect(result.errorCategory).toBe("auth:invalid_action");
    expect(capturedPrompt).toContain("```toon");
    expect(capturedPrompt).toContain("raw:");
    expect(capturedPrompt).toContain("decoded:");
    expect(capturedPrompt).toContain("customSections:");
    expect(capturedPrompt).toContain("\t");
  });

  it("drops duplicate low-value sections and summarizes contract blobs when the prompt is oversized", async () => {
    const env = createTestEnv();
    let capturedPrompt = "";
    const huge = "x".repeat(70000);
    env.AI = {
      run: vi.fn(async (_model, params: any) => {
        capturedPrompt = params.messages[1].content;
        return JSON.stringify({
          summary: "summary",
          errorCategory: "auth:invalid_action",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["tx_bad_auth"],
          debugSteps: ["step"],
          confidence: "high",
        });
      }),
    } as unknown as Ai;

    await analyzeFailedTransaction(
      env,
      createFailedTx({
        envelopeJson: { envelope: huge },
        processingJson: { processing: huge },
        decoded: {
          ...createFailedTx().decoded,
          decodedEnvelope: { decodedEnvelope: huge },
          decodedProcessing: { decodedProcessing: huge },
          diagnosticEvents: Array.from({ length: 250 }, (_, index) => ({
            type: "diagnostic",
            index,
            message: huge,
          })),
        },
      }),
      createContractMetadata(),
    );

    expect(capturedPrompt).toContain("```toon");
    expect(capturedPrompt).not.toContain("raw:");
    expect(capturedPrompt).not.toContain("decoded:");
    expect(capturedPrompt).toContain("contractspecv0Entries:");
    expect(capturedPrompt).not.toContain("contractmetav0[");
  });
});
