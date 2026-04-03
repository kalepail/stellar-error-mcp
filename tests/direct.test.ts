import { describe, expect, it, vi } from "vitest";

vi.mock("@stellar/stellar-sdk", () => ({
  xdr: {
    TransactionEnvelope: {
      fromXDR: vi.fn(() => ({
        tx: {
          tx: {
            source_account: "GAAAA",
            operations: [
              {
                body: {
                  invoke_host_function: {
                    host_function: {
                      invoke_contract: {
                        contract_address:
                          "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                        function_name: "transfer",
                        args: [],
                      },
                    },
                    auth: [],
                  },
                },
              },
            ],
          },
        },
      })),
    },
    TransactionResult: {
      fromXDR: vi.fn(() => ({
        result: {
          tx_bad_seq: {},
        },
      })),
    },
    DiagnosticEvent: {
      fromXDR: vi.fn(() => ({
        event: "diagnostic",
        error: {
          auth: "invalid_action",
        },
      })),
    },
  },
}));

vi.mock("../src/transaction.js", () => ({
  buildDecodedTransactionContext: (envelope: any, processing: any) => ({
    topLevelFunction:
      envelope?.tx?.tx?.operations?.[0]?.body?.invoke_host_function?.host_function
        ?.invoke_contract?.function_name ?? "unknown",
    errorSignatures: Array.isArray(processing?.tx_apply_processing?.v4?.diagnostic_events)
      ? processing.tx_apply_processing.v4.diagnostic_events
        .flatMap((item: any) =>
          item?.error && typeof item.error === "object"
            ? Object.entries(item.error).map(([type, code]) => ({
              type,
              code: String(code),
            }))
            : []
        )
      : [],
    invokeCalls: [
      {
        contractId:
          envelope?.tx?.tx?.operations?.[0]?.body?.invoke_host_function?.host_function
            ?.invoke_contract?.contract_address,
        functionName:
          envelope?.tx?.tx?.operations?.[0]?.body?.invoke_host_function?.host_function
            ?.invoke_contract?.function_name,
      },
    ],
    authEntries: [],
    resourceLimits: null,
    transactionResult: processing?.result ?? null,
    sorobanMeta: null,
    contractEvents: [],
    diagnosticEvents: processing?.tx_apply_processing?.v4?.diagnostic_events ?? [],
    envelopeOperations: envelope?.tx?.tx?.operations ?? [],
    processingOperations: [],
    ledgerChanges: [],
    touchedContractIds: [
      envelope?.tx?.tx?.operations?.[0]?.body?.invoke_host_function?.host_function
        ?.invoke_contract?.contract_address,
    ].filter(Boolean),
  }),
  collectContractIdsFromValue: (value: any) => {
    const contractId =
      value?.tx?.tx?.operations?.[0]?.body?.invoke_host_function?.host_function
        ?.invoke_contract?.contract_address;
    return contractId ? [contractId] : [];
  },
}));

describe("direct error normalization", () => {
  it("accepts only the canonical direct submission shape", async () => {
    const { parseDirectErrorSubmission } = await import("../src/direct.js");

    expect(() =>
      parseDirectErrorSubmission({
        kind: "rpc_send",
        transaction_xdr: "AAAA",
        sendTransactionResponse: { status: "ERROR" },
      })
    ).toThrow("transactionXdr is required");
  });

  it("parses rpc send errors into failed transactions", async () => {
    const { buildFailedTransactionFromDirectError } = await import("../src/direct.js");

    const tx = await buildFailedTransactionFromDirectError({
      kind: "rpc_send",
      transactionXdr: "AAAA",
      response: {
        status: "ERROR",
        hash: "abc123",
        latestLedger: 123,
        latestLedgerCloseTime: 1712016000,
        errorResultXdr: "BBBB",
        diagnosticEventsXdr: ["CCCC"],
      },
    });

    expect(tx.observationKind).toBe("rpc_send");
    expect(tx.txHash).toBe("abc123");
    expect(tx.resultKind).toBe("tx_bad_seq");
    expect(tx.readout.rpcStatus).toBe("ERROR");
    expect(tx.decoded.topLevelFunction).toBe("transfer");
    expect(tx.contractIds).toContain(
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
  });

  it("parses rpc simulate failures into failed transactions", async () => {
    const { buildFailedTransactionFromDirectError } = await import("../src/direct.js");

    const tx = await buildFailedTransactionFromDirectError({
      kind: "rpc_simulate",
      transactionXdr: "AAAA",
      response: {
        latestLedger: 456,
        error: "HostError: Error(Auth, InvalidAction)",
        events: ["CCCC"],
      },
    });

    expect(tx.observationKind).toBe("rpc_simulate");
    expect(tx.txHash).toMatch(/^rpcsim-/);
    expect(tx.resultKind).toBe("simulate:hosterror_error_auth_invalidaction");
    expect(tx.readout.simulationError).toBe(
      "HostError: Error(Auth, InvalidAction)",
    );
    expect(tx.decoded.errorSignatures).toEqual([
      { type: "auth", code: "invalid_action" },
    ]);
  });
});
