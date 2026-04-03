import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers.js";

vi.mock("@stellar/stellar-sdk", () => ({
  xdr: {
    TransactionEnvelope: {
      fromXDR: vi.fn(() => ({
        tx: {
          tx: {
            operations: [
              {
                body: {
                  invoke_host_function: {
                    host_function: {
                      invoke_contract: {
                        contract_address: "C1",
                        function_name: "transfer",
                      },
                    },
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
          tx_failed: {},
        },
      })),
    },
    TransactionMeta: {
      fromXDR: vi.fn(() => ({
        v4: {
          operations: [],
          events: [],
          soroban_meta: null,
        },
      })),
    },
    DiagnosticEvent: {
      fromXDR: vi.fn(() => ({
        error: { contract: 10 },
      })),
    },
  },
}));

vi.mock("../src/transaction.js", () => ({
  buildDecodedTransactionContext: () => ({
    topLevelFunction: "transfer",
    errorSignatures: [{ type: "contract", code: "10" }],
    invokeCalls: [{ contractId: "C1", functionName: "transfer" }],
    authEntries: [],
    resourceLimits: null,
    transactionResult: null,
    sorobanMeta: null,
    contractEvents: [],
    diagnosticEvents: [{ error: { contract: 10 } }],
    envelopeOperations: [],
    processingOperations: [],
    ledgerChanges: [],
    touchedContractIds: ["C1"],
  }),
}));

describe("stellar archive RPC auth", () => {
  it("uses path auth for archive ledger scans when configured", async () => {
    const { scanForFailedTransactions } = await import("../src/stellar.js");
    const env = createTestEnv();
    env.STELLAR_RPC_AUTH_MODE = "path";
    env.STELLAR_ARCHIVE_RPC_ENDPOINT = "https://archive-rpc.example.com/";
    env.STELLAR_ARCHIVE_RPC_TOKEN = "archive-token";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: { ledgers: [], cursor: undefined } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await scanForFailedTransactions(env, 25, 5);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://archive-rpc.example.com/archive-token",
      expect.objectContaining({
        headers: expect.not.objectContaining({
          Authorization: expect.anything(),
        }),
      }),
    );

    fetchMock.mockRestore();
  });

  it("rebuilds a failed transaction from getTransaction", async () => {
    const { getFailedTransactionByHash } = await import("../src/stellar.js");
    const env = createTestEnv();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        result: {
          status: "FAILED",
          txHash: "tx-restore-1",
          ledger: 321,
          createdAt: 1712016000,
          latestLedgerCloseTime: 1712016005,
          envelopeXdr: "AAAA",
          resultXdr: "BBBB",
          resultMetaXdr: "CCCC",
          diagnosticEventsXdr: ["DDDD"],
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const tx = await getFailedTransactionByHash(env, "tx-restore-1");

    expect(tx).toMatchObject({
      txHash: "tx-restore-1",
      ledgerSequence: 321,
      resultKind: "tx_failed",
      contractIds: ["C1"],
      primaryContractIds: ["C1"],
      ledgerCloseTime: "1712016000",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rpc.example.com",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "getTransaction",
          params: {
            hash: "tx-restore-1",
            xdrFormat: "base64",
          },
        }),
      }),
    );

    fetchMock.mockRestore();
  });
});
