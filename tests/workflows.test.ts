import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers.js";
import {
  getAsyncJob,
  storeAsyncJob,
  storeJobInput,
  storeStagedFailedTransaction,
} from "../src/storage.js";
import type { FailedTransaction } from "../src/types.js";

const scanForFailedTransactions = vi.fn();
const getLatestLedger = vi.fn();
const ingestFailedTransaction = vi.fn();

vi.mock("../src/stellar.js", () => ({
  scanForFailedTransactions,
  getLatestLedger,
}));

vi.mock("../src/ingest.js", () => ({
  ingestFailedTransaction,
}));

vi.mock("../src/jobs.js", () => ({
  updateJob: (job: Record<string, unknown>, patch: Record<string, unknown>) => ({
    ...job,
    ...patch,
    updatedAt: "2026-04-02T00:01:00.000Z",
  }),
  sanitizeExampleTransaction: (example: unknown) => example,
  workflowStatusToAsyncStatus: (status: string) =>
    status === "complete"
      ? "completed"
      : status === "errored"
      ? "failed"
      : status === "running"
      ? "running"
      : status === "waiting"
      ? "waiting"
      : "queued",
}));

vi.mock("../src/direct.js", () => ({
  buildFailedTransactionFromDirectError: async () => {
    throw new Error("not expected in this test");
  },
}));

function createStepRecorder() {
  const names: string[] = [];
  return {
    names,
    step: {
      do: async (
        name: string,
        configOrCallback: unknown,
        maybeCallback?: (ctx: { attempt: number }) => Promise<unknown>,
      ) => {
        names.push(name);
        const callback = typeof configOrCallback === "function"
          ? configOrCallback as (ctx: { attempt: number }) => Promise<unknown>
          : maybeCallback!;
        return callback({ attempt: 1 });
      },
      sleep: async () => undefined,
      sleepUntil: async () => undefined,
      waitForEvent: async () => ({
        payload: {},
        timestamp: new Date(),
        type: "test",
      }),
    } as WorkflowStep,
  };
}

function createFailedTx(txHash: string): FailedTransaction {
  return {
    observationKind: "ledger_scan",
    txHash,
    ledgerSequence: 12,
    ledgerCloseTime: "2026-04-02T00:00:00.000Z",
    resultKind: "tx_failed",
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
      observationKind: "ledger_scan",
      resultKind: "tx_failed",
      feeBump: false,
      invokeCallCount: 0,
      contractCount: 0,
      hasSorobanMeta: false,
      hasEvents: false,
      hasDiagnosticEvents: false,
    },
  };
}

describe("workflow classes", () => {
  beforeEach(() => {
    scanForFailedTransactions.mockReset();
    getLatestLedger.mockReset();
    ingestFailedTransaction.mockReset();
  });

  it("marks a direct job failed when normalization input is missing", async () => {
    const env = createTestEnv();
    await storeAsyncJob(env, {
      jobId: "de_missing",
      kind: "direct_error",
      status: "queued",
      phase: "accepted",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      progress: { completed: 0, total: 4, unit: "steps" },
    });

    const { DirectErrorWorkflow } = await import("../src/workflows.js");
    const workflow = new DirectErrorWorkflow(
      { waitUntil: () => undefined } as ExecutionContext,
      env,
    );
    const { step } = createStepRecorder();

    await expect(
      workflow.run(
        {
          payload: { jobId: "de_missing" },
          timestamp: new Date(),
          instanceId: "de_missing",
        },
        step,
      ),
    ).rejects.toThrow();

    const job = await getAsyncJob(env, "de_missing");
    expect(job).toMatchObject({
      status: "failed",
      phase: "failed",
      workflowStatus: "errored",
    });
  });

  it("ingests a staged direct error artifact without re-normalizing it", async () => {
    const env = createTestEnv();
    const tx = createFailedTx("tx_direct_1");
    ingestFailedTransaction.mockResolvedValue({
      status: "new",
      fingerprint: "fp-direct",
      entry: { fingerprint: "fp-direct" },
      example: null,
    });

    await storeAsyncJob(env, {
      jobId: "de_staged",
      kind: "direct_error",
      status: "queued",
      phase: "accepted",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      progress: { completed: 0, total: 4, unit: "steps" },
    });
    const stagedTransactionKey = await storeStagedFailedTransaction(
      env,
      "de_staged",
      tx.txHash,
      tx,
    );
    await storeJobInput(env, "de_staged", {
      jobId: "de_staged",
      sourceReference: "rpcsend-1",
      stagedTransactionKey,
    });

    const { DirectErrorWorkflow } = await import("../src/workflows.js");
    const workflow = new DirectErrorWorkflow(
      { waitUntil: () => undefined } as ExecutionContext,
      env,
    );
    const recorder = createStepRecorder();

    await workflow.run(
      {
        payload: { jobId: "de_staged" },
        timestamp: new Date(),
        instanceId: "de_staged",
      },
      recorder.step,
    );

    expect(recorder.names).toContain("load-staged-transaction");
    expect(ingestFailedTransaction).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ txHash: "tx_direct_1" }),
    );
    await expect(getAsyncJob(env, "de_staged")).resolves.toMatchObject({
      status: "completed",
      phase: "completed",
    });
  });

  it("stages chunk transactions and uses deterministic step names", async () => {
    const env = createTestEnv();
    const tx = createFailedTx("tx_hash_1");
    scanForFailedTransactions.mockResolvedValue({
      transactions: [tx],
      lastLedgerProcessed: 19,
      pagesScanned: 1,
      ledgersScanned: 10,
    });
    ingestFailedTransaction.mockResolvedValue({
      status: "new",
      fingerprint: "fp-1",
      entry: { fingerprint: "fp-1" },
      example: null,
    });

    await storeAsyncJob(env, {
      jobId: "lb_chunks",
      kind: "ledger_batch",
      status: "queued",
      phase: "accepted",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      progress: { completed: 0, unit: "ledgers" },
    });
    await storeJobInput(env, "lb_chunks", {
      jobId: "lb_chunks",
      kind: "ledger_batch",
      mode: "batch",
      startLedger: 10,
      endLedger: 20,
      updateCursor: false,
      initiatedBy: "test",
    });

    const { LedgerRangeWorkflow } = await import("../src/workflows.js");
    const workflow = new LedgerRangeWorkflow(
      { waitUntil: () => undefined } as ExecutionContext,
      env,
    );
    const recorder = createStepRecorder();

    await workflow.run(
      {
        payload: { jobId: "lb_chunks" },
        timestamp: new Date(),
        instanceId: "lb_chunks",
      },
      recorder.step,
    );

    expect(recorder.names).toContain("scan-chunk-10-20");
    expect(recorder.names).toContain("ingest-tx-tx_hash_1");
    expect(
      [...env.ERRORS_BUCKET.objects.keys()].some((key) =>
        key.startsWith("job-staging/lb_chunks/transactions/"),
      ),
    ).toBe(true);
  });

  it("updates the cursor only after a successful recurring scan", async () => {
    const env = createTestEnv();
    await env.CURSOR_KV.put("last_processed_ledger", "10");
    scanForFailedTransactions.mockResolvedValue({
      transactions: [],
      lastLedgerProcessed: 25,
      pagesScanned: 1,
      ledgersScanned: 15,
    });
    getLatestLedger.mockResolvedValue(40);
    ingestFailedTransaction.mockResolvedValue({
      status: "duplicate",
      fingerprint: "fp-1",
      entry: { fingerprint: "fp-1" },
      example: null,
    });

    await storeAsyncJob(env, {
      jobId: "rs_success",
      kind: "recurring_scan",
      status: "queued",
      phase: "accepted",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      progress: { completed: 0, unit: "ledgers" },
    });
    await storeJobInput(env, "rs_success", {
      jobId: "rs_success",
      kind: "recurring_scan",
      mode: "recurring",
      updateCursor: true,
      initiatedBy: "test",
    });

    const { LedgerRangeWorkflow } = await import("../src/workflows.js");
    const workflow = new LedgerRangeWorkflow(
      { waitUntil: () => undefined } as ExecutionContext,
      env,
    );
    const { step } = createStepRecorder();

    await workflow.run(
      {
        payload: { jobId: "rs_success" },
        timestamp: new Date(),
        instanceId: "rs_success",
      },
      step,
    );

    await expect(env.CURSOR_KV.get("last_processed_ledger")).resolves.toBe("25");
  });

  it("does not advance the cursor when a recurring scan fails", async () => {
    const env = createTestEnv();
    await env.CURSOR_KV.put("last_processed_ledger", "10");
    getLatestLedger.mockResolvedValue(40);
    scanForFailedTransactions.mockRejectedValue(new Error("scan failed"));

    await storeAsyncJob(env, {
      jobId: "rs_failed",
      kind: "recurring_scan",
      status: "queued",
      phase: "accepted",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      progress: { completed: 0, unit: "ledgers" },
    });
    await storeJobInput(env, "rs_failed", {
      jobId: "rs_failed",
      kind: "recurring_scan",
      mode: "recurring",
      updateCursor: true,
      initiatedBy: "test",
    });

    const { LedgerRangeWorkflow } = await import("../src/workflows.js");
    const workflow = new LedgerRangeWorkflow(
      { waitUntil: () => undefined } as ExecutionContext,
      env,
    );
    const { step } = createStepRecorder();

    await expect(
      workflow.run(
        {
          payload: { jobId: "rs_failed" },
          timestamp: new Date(),
          instanceId: "rs_failed",
        },
        step,
      ),
    ).rejects.toThrow("scan failed");

    await expect(env.CURSOR_KV.get("last_processed_ledger")).resolves.toBe("10");
  });
});
