import { describe, expect, it, vi } from "vitest";
import { buildFingerprint } from "../src/fingerprint.js";
import type { FailedTransaction } from "../src/types.js";

vi.mock("../src/transaction.js", () => ({
  extractErrorSignatures: () => [],
  extractFunctionName: () => "transfer",
}));

function createFailedTransaction(simulationError: string): FailedTransaction {
  return {
    observationKind: "rpc_simulate",
    txHash: "tx-1",
    ledgerSequence: 1,
    ledgerCloseTime: "2026-04-03T00:00:00.000Z",
    resultKind: "simulate:hosterror",
    soroban: true,
    primaryContractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"],
    contractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"],
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
      simulationError,
    },
  };
}

describe("fingerprint fallback signatures", () => {
  it("normalizes simulation errors before hashing", async () => {
    const compact = await buildFingerprint(
      createFailedTransaction("HostError: Error(Auth, InvalidAction)"),
    );
    const noisy = await buildFingerprint(
      createFailedTransaction("  hosterror:  error(auth, invalidaction)  "),
    );

    expect(compact.errorSignatures).toEqual([
      { type: "result", code: "simulate:hosterror" },
      { type: "simulation", code: "hosterror_error_auth_invalidaction" },
    ]);
    expect(noisy.errorSignatures).toEqual(compact.errorSignatures);
    expect(noisy.fingerprint).toBe(compact.fingerprint);
  });

  it("scopes identical failures differently on testnet and mainnet", async () => {
    const testnet = await buildFingerprint({
      ...createFailedTransaction("HostError: Error(Auth, InvalidAction)"),
      rpcContext: { network: "testnet" },
    });
    const mainnet = await buildFingerprint({
      ...createFailedTransaction("HostError: Error(Auth, InvalidAction)"),
      rpcContext: { network: "mainnet" },
    });

    expect(testnet.errorSignatures).toEqual(mainnet.errorSignatures);
    expect(testnet.fingerprint).not.toBe(mainnet.fingerprint);
  });
});
