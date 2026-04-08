import type {
  AsyncJob,
  AsyncJobKind,
  AsyncJobPhase,
  AsyncJobProgress,
  AsyncJobStatus,
  DirectErrorSubmission,
  DirectErrorWorkflowInput,
  FailedTransaction,
  PublicContractMetadata,
  PublicDecodedTransactionContext,
  PublicErrorEntry,
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
  forceReanalyze: boolean;
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

  return {
    ...example,
    transaction: sanitizeFailedTransaction(example.transaction),
    contracts: sanitizeContractMetadata(example.contracts),
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

function compactPublicValue(
  value: unknown,
  depth = 0,
): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    return value.length > 600 ? `${value.slice(0, 600)}... [truncated]` : value;
  }
  if (typeof value !== "object") return value;
  if (depth >= 4) return "[max-depth]";

  if (Array.isArray(value)) {
    const limit = depth <= 1 ? 6 : 4;
    const next = value.slice(0, limit).map((item) => compactPublicValue(item, depth + 1));
    if (value.length > limit) {
      next.push({
        _truncated: true,
        keptItems: limit,
        remainingItems: value.length - limit,
      });
    }
    return next;
  }

  const record = value as Record<string, unknown>;
  const normalized =
    "_attributes" in record && Object.keys(record).length <= 2
      ? record._attributes
      : record;

  const next: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(normalized as Record<string, unknown>)) {
    if (
      key === "_maxDepth" ||
      key === "_armType" ||
      key === "_childType" ||
      key === "direct" ||
      key === "sourcePayload"
    ) {
      continue;
    }
    next[key] = compactPublicValue(inner, depth + 1);
  }
  return next;
}

function buildEventPreview(events: unknown[]): { count: number; preview: unknown[] } {
  return {
    count: events.length,
    preview: events.slice(0, 3).map((event) => compactPublicValue(event)),
  };
}

function sanitizeReadout(
  readout: FailedTransaction["readout"],
): FailedTransaction["readout"] {
  return {
    ...readout,
    simulationError:
      typeof readout.simulationError === "string" && readout.simulationError.length > 1200
        ? `${readout.simulationError.slice(0, 1200)}... [truncated]`
        : readout.simulationError,
  };
}

function sanitizeDecodedContext(
  decoded: FailedTransaction["decoded"],
): PublicDecodedTransactionContext {
  return {
    topLevelFunction: decoded.topLevelFunction,
    errorSignatures: decoded.errorSignatures,
    invokeCalls: decoded.invokeCalls.slice(0, 6).map((call) => ({
      contractId: call.contractId,
      functionName: call.functionName,
      argCount: call.argCount ?? (Array.isArray(call.args) ? call.args.length : undefined),
      authCount: call.authCount ?? (Array.isArray(call.auth) ? call.auth.length : undefined),
    })),
    authEntryCount: decoded.authEntries.length,
    authEntryPreview: decoded.authEntries.slice(0, 3).map((entry) => compactPublicValue(entry)),
    resourceLimits: decoded.resourceLimits,
    transactionResult: compactPublicValue(decoded.transactionResult),
    contractEvents: buildEventPreview(decoded.contractEvents),
    diagnosticEvents: buildEventPreview(decoded.diagnosticEvents),
    processingOperationCount: decoded.processingOperations.length,
    ledgerChangeCount: decoded.ledgerChanges.length,
    touchedContractIds: decoded.touchedContractIds,
  };
}

export function sanitizeFailedTransaction(
  transaction: FailedTransaction,
): PublicExampleTransactionRecord["transaction"] {
  return {
    observationKind: transaction.observationKind,
    txHash: transaction.txHash,
    ledgerSequence: transaction.ledgerSequence,
    ledgerCloseTime: transaction.ledgerCloseTime,
    resultKind: transaction.resultKind,
    soroban: transaction.soroban,
    primaryContractIds: transaction.primaryContractIds,
    contractIds: transaction.contractIds,
    operationTypes: transaction.operationTypes,
    sorobanOperationTypes: transaction.sorobanOperationTypes,
    readout: sanitizeReadout(transaction.readout),
    rpcContext: transaction.rpcContext,
    decoded: sanitizeDecodedContext(
      scrubSubmissionData(transaction.decoded) as FailedTransaction["decoded"],
    ),
  };
}

function sanitizeContractMetadata(
  contracts: ExampleTransactionRecord["contracts"],
): PublicContractMetadata[] {
  return contracts.map((contract) => ({
    contractId: contract.contractId,
    wasmHash: contract.wasmHash,
    contractType: contract.contractType,
    builtin: contract.builtin,
    notes: contract.notes,
    assetMetadata: contract.assetMetadata,
    functionCount: contract.functions.length,
    errorEnumCount: contract.errorEnums.length,
    structCount: contract.structs.length,
  }));
}

export function sanitizeErrorEntry(
  entry: ErrorEntry,
): PublicErrorEntry {
  return {
    fingerprint: entry.fingerprint,
    observationKinds: entry.observationKinds,
    contractIds: entry.contractIds,
    functionName: entry.functionName,
    errorSignatures: entry.errorSignatures,
    resultKind: entry.resultKind,
    sorobanOperationTypes: entry.sorobanOperationTypes,
    summary: entry.summary,
    errorCategory: entry.errorCategory,
    likelyCause: entry.likelyCause,
    suggestedFix: entry.suggestedFix,
    detailedAnalysis: entry.detailedAnalysis,
    evidence: entry.evidence,
    relatedCodes: entry.relatedCodes,
    debugSteps: entry.debugSteps,
    confidence: entry.confidence,
    modelId: entry.modelId,
    seenCount: entry.seenCount,
    firstSeen: entry.firstSeen,
    lastSeen: entry.lastSeen,
    exampleTxHash: entry.exampleTxHash,
  };
}

export async function preflightDirectErrorSubmission(
  env: Env,
  submission: DirectErrorSubmission,
): Promise<DuplicatePreflightResult> {
  const { buildFailedTransactionFromDirectError } = await import("./direct.js");
  const transaction = await buildFailedTransactionFromDirectError(submission);
  const sourceReference = transaction.readout.sourceReference ?? transaction.txHash;
  const forceReanalyze = submission.forceReanalyze === true;

  if (forceReanalyze) {
    const { fingerprint } = await buildFingerprint(transaction);
    return {
      duplicate: false,
      transaction,
      fingerprint,
      sourceReference,
      forceReanalyze: true,
    };
  }

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
      forceReanalyze: false,
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
  forceReanalyze = false,
): DirectErrorWorkflowInput {
  return {
    jobId,
    sourceReference,
    stagedTransactionKey,
    txHash,
    forceReanalyze,
  };
}
