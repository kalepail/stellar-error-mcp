import { describe, expect, it, vi } from "vitest";
import { buildBuiltinInsights } from "../src/builtin-contracts.js";
import { buildContractContext } from "../src/contracts.js";
import type { ContractMetadata, FailedTransaction, ObservationKind } from "../src/types.js";

vi.mock("../src/xdr.js", () => ({
  decodeXdrStream: vi.fn(() => []),
}));

function createTx(
  observationKind: ObservationKind,
  overrides: Partial<FailedTransaction> = {},
): FailedTransaction {
  return {
    observationKind,
    txHash: `tx-${observationKind}`,
    ledgerSequence: 101,
    ledgerCloseTime: "2026-04-07T12:00:00.000Z",
    resultKind: observationKind === "rpc_simulate"
      ? "simulate:hosterror_error_auth_invalidaction"
      : "tx_failed",
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
      observationKind,
      resultKind: observationKind === "rpc_simulate"
        ? "simulate:hosterror_error_auth_invalidaction"
        : "tx_failed",
      feeBump: false,
      invokeCallCount: 0,
      contractCount: 1,
      hasSorobanMeta: false,
      hasEvents: false,
      hasDiagnosticEvents: false,
    },
    ...overrides,
  };
}

function createStellarAssetMetadata(
  overrides: Partial<ContractMetadata> = {},
): ContractMetadata {
  return {
    contractId: "C1",
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
      detectionReason: "Detected from contractExecutableStellarAsset on-ledger executable type.",
      authSemantics: ["Getters require no authorization."],
      failureModes: ["Missing trustlines on classic accounts map to TrustlineMissingError."],
    },
    functions: [],
    errorEnums: [],
    structs: [],
    notes: ["Built-in Stellar Asset Contract executable"],
    assetMetadata: {
      AssetInfo: ["Native"],
      decimal: 7,
      name: "native",
      symbol: "native",
    },
    fetchedAt: "2026-04-07T12:00:00.000Z",
    ...overrides,
  };
}

describe("builtin contract insights", () => {
  it("adds SAC-native heuristics for simulation errors", () => {
    const tx = createTx("rpc_simulate", {
      decoded: {
        ...createTx("rpc_simulate").decoded,
        topLevelFunction: "burn",
        invokeCalls: [{ contractId: "C1", functionName: "burn" }],
        errorSignatures: [{ type: "contract", code: "2" }],
      },
      rpcContext: { network: "testnet" },
    });
    const contracts = new Map<string, ContractMetadata>([
      ["C1", createStellarAssetMetadata()],
    ]);

    const insights = buildBuiltinInsights(tx, contracts);

    expect(insights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "stellar_asset_contract",
          relatedFunctions: expect.arrayContaining(["burn"]),
          relatedCodes: expect.arrayContaining(["OperationNotSupportedError"]),
          debugHints: expect.arrayContaining([
            expect.stringContaining("native asset"),
          ]),
        }),
      ]),
    );
  });

  it("detects builtin account auth insight for rpc_send failures", () => {
    const tx = createTx("rpc_send", {
      decoded: {
        ...createTx("rpc_send").decoded,
        diagnosticEvents: [{ fn_name: "__check_auth" }],
        invokeCalls: [{ contractId: "C2", functionName: "__check_auth" }],
      },
    });

    const insights = buildBuiltinInsights(tx);
    const context = buildContractContext(new Map(), insights);

    expect(insights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "account_contract",
          relatedFunctions: expect.arrayContaining(["__check_auth"]),
          relatedCodes: expect.arrayContaining(["AuthenticationError"]),
        }),
      ]),
    );
    expect(context).toContain("Built-in Runtime Insights:");
    expect(context).toContain("Builtin Account Contract");
  });

  it("detects invoker auth insight for on-chain ledger failures", () => {
    const tx = createTx("ledger_scan", {
      rpcContext: { network: "mainnet" },
      decoded: {
        ...createTx("ledger_scan").decoded,
        authEntries: [{ kind: "CreateContractHostFn" }],
        decodedEnvelope: {
          authorization: "authorize_as_curr_contract",
        },
      },
    });

    const insights = buildBuiltinInsights(tx);

    expect(insights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invoker_contract_auth",
          relatedFunctions: expect.arrayContaining([
            "authorize_as_curr_contract",
            "CreateContractHostFn",
          ]),
          relatedCodes: expect.arrayContaining(["Auth.InvalidInput"]),
        }),
      ]),
    );
  });
});
