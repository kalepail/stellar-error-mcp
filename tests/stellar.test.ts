import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers.js";

vi.mock("../src/transaction.js", () => ({
  buildDecodedTransactionContext: () => ({
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
});
