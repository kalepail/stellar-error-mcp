import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { ingestFailedTransaction } from "./ingest.js";
import { updateJob, sanitizeExampleTransaction, workflowStatusToAsyncStatus } from "./jobs.js";
import {
  getActiveRecurringScanRecord,
  getAsyncJob,
  getJobInput,
  getJobStepResult,
  getStagedFailedTransaction,
  setActiveRecurringScanRecord,
  storeAsyncJob,
  storeJobResultArtifact,
  storeJobStepResult,
  storeStagedFailedTransaction,
} from "./storage.js";
import { getLatestLedger, scanForFailedTransactions } from "./stellar.js";
import { setLastProcessedLedger, getLastProcessedLedger } from "./storage.js";
import type {
  AsyncJob,
  DirectErrorJobResult,
  DirectErrorWorkflowInput,
  DirectErrorWorkflowParams,
  Env,
  FailedTransaction,
  LedgerChunkIngestSummary,
  LedgerChunkSummary,
  LedgerRangeJobResult,
  LedgerRangeWorkflowInput,
  LedgerRangeWorkflowParams,
  StagedFailedTransactionRef,
} from "./types.js";

const MAX_LEDGERS_PER_CYCLE = 200;
const COLD_START_LOOKBACK = 50;
const LEDGER_SCAN_FAIL_LIMIT = 10_000;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildChunkStepName(startLedger: number, endLedger: number): string {
  return `scan-chunk-${startLedger}-${endLedger}`;
}

function buildIngestStepName(txHash: string): string {
  const safe = txHash.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return `ingest-tx-${safe}`;
}

async function loadJobOrThrow(env: Env, jobId: string): Promise<AsyncJob> {
  const job = await getAsyncJob(env, jobId);
  if (!job) {
    throw new NonRetryableError(`Job ${jobId} not found.`, "JobNotFound");
  }
  return job;
}

async function updateStoredJob(
  env: Env,
  jobId: string,
  patch: Partial<Omit<AsyncJob, "jobId" | "kind" | "createdAt">>,
): Promise<AsyncJob> {
  const job = await loadJobOrThrow(env, jobId);
  const next = updateJob(job, patch);
  await storeAsyncJob(env, next);
  return next;
}

function ensureDirectInput(
  input: unknown,
  jobId: string,
): DirectErrorWorkflowInput {
  if (!input || typeof input !== "object") {
    throw new NonRetryableError(`Direct workflow input missing for ${jobId}.`);
  }
  const record = input as Partial<DirectErrorWorkflowInput>;
  if (!record.sourceReference || !record.stagedTransactionKey) {
    throw new NonRetryableError(`Direct workflow input malformed for ${jobId}.`);
  }
  return record as DirectErrorWorkflowInput;
}

function ensureLedgerInput(
  input: unknown,
  jobId: string,
): LedgerRangeWorkflowInput {
  if (!input || typeof input !== "object") {
    throw new NonRetryableError(`Ledger workflow input missing for ${jobId}.`);
  }
  const record = input as Partial<LedgerRangeWorkflowInput>;
  if (!record.kind || !record.mode || typeof record.updateCursor !== "boolean") {
    throw new NonRetryableError(`Ledger workflow input malformed for ${jobId}.`);
  }
  return record as LedgerRangeWorkflowInput;
}

async function finalizeFailedJob(
  env: Env,
  jobId: string,
  error: unknown,
): Promise<void> {
  const message = formatError(error);
  await updateStoredJob(env, jobId, {
    status: "failed",
    phase: "failed",
    progress: { completed: 0, unit: "steps", message },
    workflowStatus: "errored",
    error: message,
  });
}

async function clearRecurringScanIfNeeded(
  env: Env,
  jobId: string,
): Promise<void> {
  const active = await getActiveRecurringScanRecord(env);
  if (active?.jobId === jobId) {
    await setActiveRecurringScanRecord(env, null);
  }
}

async function resolveLedgerRange(
  env: Env,
  input: LedgerRangeWorkflowInput,
): Promise<{ batchStart: number; batchEnd: number }> {
  if (typeof input.startLedger === "number" && typeof input.endLedger === "number") {
    if (input.endLedger <= input.startLedger) {
      throw new NonRetryableError("endLedger must be greater than startLedger.");
    }
    return { batchStart: input.startLedger, batchEnd: input.endLedger };
  }

  const latestLedger = await getLatestLedger(env);
  if (typeof input.hours === "number") {
    const batchEnd = latestLedger;
    const batchStart = Math.max(1, batchEnd - Math.floor((input.hours * 3600) / 5));
    if (batchEnd <= batchStart) {
      throw new NonRetryableError("Resolved batch range is empty.");
    }
    return { batchStart, batchEnd };
  }

  const lastProcessed = await getLastProcessedLedger(env);
  const batchStart = Math.max(1, lastProcessed === null
    ? latestLedger - COLD_START_LOOKBACK
    : lastProcessed + 1);
  const batchEnd = Math.max(
    batchStart,
    Math.min(latestLedger + 1, batchStart + MAX_LEDGERS_PER_CYCLE),
  );
  return { batchStart, batchEnd };
}

async function scanChunk(
  env: Env,
  jobId: string,
  startLedger: number,
  endLedger: number,
): Promise<LedgerChunkSummary> {
  const stepName = buildChunkStepName(startLedger, endLedger);
  const cached = await getJobStepResult<LedgerChunkSummary>(env, jobId, stepName);
  if (cached) return cached;

  const chunkLedgers = Math.max(0, endLedger - startLedger);
  const scanResult = await scanForFailedTransactions(
    env,
    startLedger,
    chunkLedgers,
    LEDGER_SCAN_FAIL_LIMIT,
  );

  const refs: StagedFailedTransactionRef[] = [];
  for (const transaction of scanResult.transactions) {
    const key = await storeStagedFailedTransaction(
      env,
      jobId,
      transaction.txHash,
      transaction,
    );
    refs.push({ key, txHash: transaction.txHash });
  }

  const summary: LedgerChunkSummary = {
    startLedger,
    endLedger,
    ledgersScanned: scanResult.ledgersScanned,
    pagesScanned: scanResult.pagesScanned,
    failedTransactions: scanResult.transactions.length,
    refs,
    lastLedgerProcessed: scanResult.lastLedgerProcessed,
  };

  await storeJobStepResult(env, jobId, stepName, summary);
  return summary;
}

async function ingestStagedTransaction(
  env: Env,
  jobId: string,
  ref: StagedFailedTransactionRef,
): Promise<LedgerChunkIngestSummary> {
  const stepName = buildIngestStepName(ref.txHash);
  const cached = await getJobStepResult<LedgerChunkIngestSummary>(env, jobId, stepName);
  if (cached) return cached;

  const transaction = await getStagedFailedTransaction(env, ref.key);
  if (!transaction) {
    throw new NonRetryableError(`Staged transaction ${ref.key} not found.`);
  }

  const result = await ingestFailedTransaction(env, transaction as FailedTransaction);
  const summary: LedgerChunkIngestSummary = {
    newErrors: result.status === "new" ? 1 : 0,
    duplicates: result.status === "duplicate" ? 1 : 0,
  };
  await storeJobStepResult(env, jobId, stepName, summary);
  return summary;
}

export class DirectErrorWorkflow extends WorkflowEntrypoint<
  Env,
  DirectErrorWorkflowParams
> {
  async run(event: Readonly<WorkflowEvent<DirectErrorWorkflowParams>>, step: WorkflowStep) {
    const jobId = event.payload.jobId;

    try {
      await updateStoredJob(this.env, jobId, {
        status: "running",
        phase: "dedupe",
        workflowStatus: "running",
        progress: { completed: 0, total: 4, unit: "steps", message: "Starting direct error workflow." },
      });

      await step.do("load-input", async () => {
        ensureDirectInput(await getJobInput(this.env, jobId), jobId);
        await updateStoredJob(this.env, jobId, {
          phase: "dedupe",
          progress: { completed: 1, total: 4, unit: "steps", message: "Loaded direct job input." },
        });
        return { ok: true };
      });
      const input = ensureDirectInput(await getJobInput(this.env, jobId), jobId);

      const normalizedRef = await step.do("load-staged-transaction", async () => {
        const transaction = await getStagedFailedTransaction(
          this.env,
          input.stagedTransactionKey,
        );
        if (!transaction) {
          throw new NonRetryableError(
            `Normalized transaction ${input.stagedTransactionKey} not found.`,
          );
        }
        await updateStoredJob(this.env, jobId, {
          phase: "dedupe",
          sourceReference: input.sourceReference,
          progress: { completed: 2, total: 4, unit: "steps", message: "Loaded normalized direct error payload." },
        });
        return { key: input.stagedTransactionKey, txHash: transaction.txHash };
      });

      await step.do("ingest-direct-error", async () => {
        const cached = await getJobStepResult<DirectErrorJobResult>(
          this.env,
          jobId,
          "ingest-direct-error",
        );
        if (cached) {
          return { resultKey: "ingest-direct-error" };
        }

        const transaction = await getStagedFailedTransaction(this.env, normalizedRef.key);
        if (!transaction) {
          throw new NonRetryableError(`Normalized transaction ${normalizedRef.key} not found.`);
        }

        await updateStoredJob(this.env, jobId, {
          phase: "analyzing",
          progress: { completed: 3, total: 4, unit: "steps", message: "Analyzing and storing error." },
        });

        const ingest = await ingestFailedTransaction(this.env, transaction as FailedTransaction);
        const publicResult: DirectErrorJobResult = {
          duplicate: ingest.status === "duplicate",
          fingerprint: ingest.fingerprint,
          entry: ingest.entry,
          example: sanitizeExampleTransaction(ingest.example),
        };
        await storeJobStepResult(this.env, jobId, "ingest-direct-error", publicResult);
        return { resultKey: "ingest-direct-error" };
      });

      await step.do("finalize-direct-job", async () => {
        const result = await getJobStepResult<DirectErrorJobResult>(
          this.env,
          jobId,
          "ingest-direct-error",
        );
        if (!result) {
          throw new NonRetryableError("Direct workflow result missing during finalization.");
        }
        await updateStoredJob(this.env, jobId, {
          status: "completed",
          phase: "completed",
          workflowStatus: "complete",
          progress: { completed: 4, total: 4, unit: "steps", message: "Direct error workflow completed." },
          result,
        });
        return null;
      });

      return await getJobStepResult<DirectErrorJobResult>(
        this.env,
        jobId,
        "ingest-direct-error",
      );
    } catch (error) {
      await step.do("finalize-direct-failure", async () => {
        await finalizeFailedJob(this.env, jobId, error);
        return null;
      });
      throw error;
    }
  }
}

export class LedgerRangeWorkflow extends WorkflowEntrypoint<
  Env,
  LedgerRangeWorkflowParams
> {
  async run(event: Readonly<WorkflowEvent<LedgerRangeWorkflowParams>>, step: WorkflowStep) {
    const jobId = event.payload.jobId;

    try {
      await updateStoredJob(this.env, jobId, {
        status: "running",
        phase: "scanning",
        workflowStatus: "running",
        progress: { completed: 0, unit: "ledgers", message: "Starting ledger workflow." },
      });

      const input = await step.do("load-input", async () => {
        const stored = await getJobInput(this.env, jobId);
        const ledgerInput = ensureLedgerInput(stored, jobId);
        await updateStoredJob(this.env, jobId, {
          phase: "preflight",
          progress: { completed: 0, unit: "ledgers", message: "Loaded ledger workflow input." },
        });
        return ledgerInput;
      });

      const range = await step.do("resolve-range", async () => {
        const resolved = await resolveLedgerRange(this.env, input);
        await updateStoredJob(this.env, jobId, {
          phase: "scanning",
          progress: {
            completed: 0,
            total: Math.max(0, resolved.batchEnd - resolved.batchStart),
            unit: "ledgers",
            message: `Resolved range ${resolved.batchStart}-${resolved.batchEnd}.`,
          },
        });
        return resolved;
      });

      let cursor = range.batchStart;
      let ledgersScanned = 0;
      let pagesScanned = 0;
      let failedTransactions = 0;
      let newErrors = 0;
      let duplicates = 0;
      let lastLedgerProcessed = range.batchStart;

      while (cursor < range.batchEnd) {
        const chunkEnd = Math.min(cursor + MAX_LEDGERS_PER_CYCLE, range.batchEnd);
        const chunk = await step.do(
          buildChunkStepName(cursor, chunkEnd),
          async () => scanChunk(this.env, jobId, cursor, chunkEnd),
        );

        ledgersScanned += chunk.ledgersScanned;
        pagesScanned += chunk.pagesScanned;
        failedTransactions += chunk.failedTransactions;
        lastLedgerProcessed = Math.max(lastLedgerProcessed, chunk.lastLedgerProcessed);

        await updateStoredJob(this.env, jobId, {
          phase: "scanning",
          progress: {
            completed: Math.min(chunkEnd - range.batchStart, range.batchEnd - range.batchStart),
            total: range.batchEnd - range.batchStart,
            unit: "ledgers",
            message: `Scanned ledgers ${cursor}-${chunkEnd}.`,
          },
        });

        for (const ref of chunk.refs) {
          const ingestSummary = await step.do(
            buildIngestStepName(ref.txHash),
            async () => ingestStagedTransaction(this.env, jobId, ref),
          );
          newErrors += ingestSummary.newErrors;
          duplicates += ingestSummary.duplicates;
        }

        cursor = chunkEnd;
      }

      const result = await step.do("finalize-range-job", async () => {
        let artifactKey: string | undefined;
        const payload = {
          jobId,
          kind: input.kind,
          mode: input.mode,
          initiatedBy: input.initiatedBy,
          batchStart: range.batchStart,
          batchEnd: range.batchEnd,
          ledgersScanned,
          pagesScanned,
          failedTransactions,
          newErrors,
          duplicates,
          lastLedgerProcessed,
        };

        artifactKey = await storeJobResultArtifact(this.env, jobId, payload);

        if (input.updateCursor && input.kind === "recurring_scan" && ledgersScanned > 0) {
          await setLastProcessedLedger(this.env, lastLedgerProcessed);
        }

        const publicResult: LedgerRangeJobResult = {
          batchStart: range.batchStart,
          batchEnd: range.batchEnd,
          ledgersScanned,
          pagesScanned,
          failedTransactions,
          newErrors,
          duplicates,
          lastLedgerProcessed,
          artifactKey,
        };

        await updateStoredJob(this.env, jobId, {
          status: "completed",
          phase: "completed",
          workflowStatus: "complete",
          progress: {
            completed: range.batchEnd - range.batchStart,
            total: range.batchEnd - range.batchStart,
            unit: "ledgers",
            message: "Ledger workflow completed.",
          },
          result: publicResult,
        });

        await clearRecurringScanIfNeeded(this.env, jobId);
        return publicResult;
      });

      return result;
    } catch (error) {
      await step.do("finalize-ledger-failure", async () => {
        await finalizeFailedJob(this.env, jobId, error);
        await clearRecurringScanIfNeeded(this.env, jobId);
        return null;
      });
      throw error;
    }
  }
}

export async function syncJobWithWorkflowStatus(
  env: Env,
  job: AsyncJob,
): Promise<AsyncJob> {
  const binding = job.kind === "direct_error"
    ? env.DIRECT_ERROR_WORKFLOW
    : env.LEDGER_RANGE_WORKFLOW;
  const instance = await binding.get(job.jobId);
  const details = await instance.status();
  const nextStatus = workflowStatusToAsyncStatus(details.status);

  if (
    nextStatus === job.status &&
    job.workflowStatus === details.status
  ) {
    return job;
  }

  const next = updateJob(job, {
    status: nextStatus,
    workflowStatus: details.status,
    phase: nextStatus === "completed"
      ? "completed"
      : nextStatus === "failed"
      ? "failed"
      : job.phase,
    error: details.error?.message ?? job.error,
  });
  await storeAsyncJob(env, next);
  return next;
}
