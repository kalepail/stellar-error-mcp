import type {
  AsyncJob,
  AsyncJobKind,
  AsyncJobPhase,
  AsyncJobProgress,
  AsyncJobStatus,
  DirectErrorSubmission,
  DirectErrorWorkflowInput,
  FailedTransaction,
  PublicExampleTransactionRecord,
} from "./types.js";
import { buildFingerprint } from "./fingerprint.js";
import {
  bumpErrorEntry,
  findErrorEntryByTxHash,
  getErrorEntry,
} from "./storage.js";
import type { Env, ErrorEntry, ExampleTransactionRecord } from "./types.js";
import { ensureExampleTransaction } from "./reference-transactions.js";

type WorkflowStatusValue =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "unknown";

export interface DuplicatePreflightMatch {
  duplicate: true;
  sourceReference: string;
  fingerprint: string;
  entry: ErrorEntry;
  example: PublicExampleTransactionRecord | null;
}

export interface DuplicatePreflightMiss {
  duplicate: false;
  transaction: FailedTransaction;
  fingerprint: string;
  sourceReference: string;
}

export type DuplicatePreflightResult =
  | DuplicatePreflightMatch
  | DuplicatePreflightMiss;

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function createJobId(kind: AsyncJobKind): string {
  const prefix = kind === "direct_error"
    ? "de_"
    : kind === "ledger_batch"
    ? "lb_"
    : "rs_";
  return `${prefix}${randomHex(10)}`;
}

export function createInitialJob(
  jobId: string,
  kind: AsyncJobKind,
  phase: AsyncJobPhase,
  progress: AsyncJobProgress,
  sourceReference?: string,
): AsyncJob {
  const now = new Date().toISOString();
  return {
    jobId,
    kind,
    status: "queued",
    phase,
    createdAt: now,
    updatedAt: now,
    progress,
    sourceReference,
  };
}

export function updateJob(
  job: AsyncJob,
  patch: Partial<Omit<AsyncJob, "jobId" | "kind" | "createdAt">>,
): AsyncJob {
  return {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

export function workflowStatusToAsyncStatus(
  workflowStatus: WorkflowStatusValue,
): AsyncJobStatus {
  switch (workflowStatus) {
    case "complete":
      return "completed";
    case "errored":
    case "terminated":
      return "failed";
    case "waiting":
    case "paused":
    case "waitingForPause":
      return "waiting";
    case "running":
      return "running";
    case "queued":
    case "unknown":
    default:
      return "queued";
  }
}

export function isTerminalJobStatus(status: AsyncJobStatus): boolean {
  return status === "completed" || status === "failed";
}

export function sanitizeExampleTransaction(
  example: ExampleTransactionRecord | null,
): PublicExampleTransactionRecord | null {
  if (!example) return null;

  const transaction = {
    ...example.transaction,
    processingJson: scrubSubmissionData(example.transaction.processingJson),
    decoded: scrubSubmissionData(example.transaction.decoded) as typeof example.transaction.decoded,
  };
  delete (transaction as { sourcePayload?: unknown }).sourcePayload;

  return {
    ...example,
    transaction,
  };
}

function scrubSubmissionData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubSubmissionData);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "direct" || key === "sourcePayload") continue;
    next[key] = scrubSubmissionData(inner);
  }
  return next;
}

export async function preflightDirectErrorSubmission(
  env: Env,
  submission: DirectErrorSubmission,
): Promise<DuplicatePreflightResult> {
  const { buildFailedTransactionFromDirectError } = await import("./direct.js");
  const transaction = await buildFailedTransactionFromDirectError(submission);
  const sourceReference = transaction.readout.sourceReference ?? transaction.txHash;

  const exactByTxHash = await findErrorEntryByTxHash(env, transaction.txHash);
  if (exactByTxHash) {
    return {
      duplicate: true,
      sourceReference,
      fingerprint: exactByTxHash.fingerprint,
      entry: exactByTxHash,
      example: sanitizeExampleTransaction(
        await ensureExampleTransaction(env, exactByTxHash.fingerprint),
      ),
    };
  }

  const { fingerprint } = await buildFingerprint(transaction);
  return applyFingerprintDuplicateCheck(env, transaction, fingerprint);
}

async function applyFingerprintDuplicateCheck(
  env: Env,
  transaction: FailedTransaction,
  fingerprint: string,
): Promise<DuplicatePreflightResult> {
  const existing = await getErrorEntry(env, fingerprint);

  if (!existing) {
    return {
      duplicate: false,
      transaction,
      fingerprint,
      sourceReference: transaction.readout.sourceReference ?? transaction.txHash,
    };
  }

  await bumpErrorEntry(
    env,
    existing,
    transaction.txHash,
    transaction.ledgerCloseTime,
    transaction.observationKind,
  );

  return {
    duplicate: true,
    sourceReference: transaction.readout.sourceReference ?? transaction.txHash,
    fingerprint,
    entry: {
      ...existing,
      observationKinds: [
        ...new Set([...existing.observationKinds, transaction.observationKind]),
      ],
      seenCount: existing.seenCount + 1,
      txHashes: [...existing.txHashes.filter((hash) => hash !== transaction.txHash), transaction.txHash]
        .slice(-50),
      lastSeen: transaction.ledgerCloseTime,
    },
    example: sanitizeExampleTransaction(
      await ensureExampleTransaction(env, fingerprint, transaction),
    ),
  };
}

export function buildDirectWorkflowInput(
  jobId: string,
  sourceReference: string,
  stagedTransactionKey: string,
  txHash: string,
): DirectErrorWorkflowInput {
  return {
    jobId,
    sourceReference,
    stagedTransactionKey,
    txHash,
  };
}
