import type {
  ActiveRecurringScanRecord,
  AsyncJob,
  AsyncJobInput,
  ContractMetadata,
  Env,
  ErrorEntry,
  ErrorReadout,
  ExampleTransactionRecord,
  FailedTransaction,
  ObservationKind,
} from "./types.js";
import { buildSearchDocument, SEARCH_DOCS_PREFIX } from "./ai-search.js";

const CURSOR_KEY = "last_processed_ledger";
const ACTIVE_RECURRING_SCAN_KEY = "active_recurring_scan_job";
const ACTIVE_DIRECT_JOB_PREFIX = "active_direct_job:";
const TX_FINGERPRINT_KV_PREFIX = "tx:";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const SIMILARITY_THRESHOLD = 0.90;
const MAX_TX_HASHES_PER_ENTRY = 50;
const REFERENCE_TRANSACTIONS_PREFIX = "reference-transactions/";
const JOBS_PREFIX = "jobs/";
const JOB_INPUTS_PREFIX = "job-inputs/";
const JOB_RESULTS_PREFIX = "job-results/";
const JOB_STAGING_PREFIX = "job-staging/";

function getWorkflowArtifactsBucket(env: Env): R2Bucket {
  return env.WORKFLOW_ARTIFACTS_BUCKET ?? env.ERRORS_BUCKET;
}

async function deleteBucketPrefix(
  bucket: R2Bucket,
  prefix: string,
): Promise<number> {
  let deleted = 0;

  while (true) {
    const listed = await bucket.list({ prefix, limit: 1000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    if (!listed.truncated) break;
  }

  return deleted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeTimestampString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }

  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) return "";

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      const millis = trimmed.length <= 10 ? numeric * 1000 : numeric;
      return new Date(millis).toISOString();
    }
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return trimmed;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string =>
    typeof item === "string" && item.length > 0
  );
}

function normalizeConfidence(
  value: unknown,
): ErrorEntry["confidence"] {
  return value === "high" ||
      value === "medium" ||
      value === "low" ||
      value === "failed"
    ? value
    : "low";
}

function normalizeObservationKind(
  value: unknown,
): ObservationKind {
  return value === "rpc_send" ||
      value === "rpc_simulate" ||
      value === "ledger_scan"
    ? value
    : "ledger_scan";
}

function normalizeObservationKinds(value: unknown): ObservationKind[] {
  if (!Array.isArray(value)) return ["ledger_scan"];

  const normalized = value
    .map((item) => normalizeObservationKind(item))
    .filter((item, index, all) => all.indexOf(item) === index);

  return normalized.length > 0 ? normalized : ["ledger_scan"];
}

function isTerminalAsyncJobStatus(status: AsyncJob["status"]): boolean {
  return status === "completed" || status === "failed";
}

function normalizeErrorReadout(
  value: unknown,
  resultKind: string,
  contractCount: number,
): ErrorReadout | null {
  if (!isRecord(value)) return null;

  return {
    observationKind: normalizeObservationKind(value.observationKind),
    resultKind: normalizeString(value.resultKind, resultKind),
    feeBump: value.feeBump === true,
    invokeCallCount: typeof value.invokeCallCount === "number"
      ? value.invokeCallCount
      : 0,
    contractCount: typeof value.contractCount === "number"
      ? value.contractCount
      : contractCount,
    sourceAccount: typeof value.sourceAccount === "string"
      ? value.sourceAccount
      : undefined,
    feeSourceAccount: typeof value.feeSourceAccount === "string"
      ? value.feeSourceAccount
      : undefined,
    hasSorobanMeta: value.hasSorobanMeta === true,
    hasEvents: value.hasEvents === true,
    hasDiagnosticEvents: value.hasDiagnosticEvents === true,
    eventCount: typeof value.eventCount === "number"
      ? value.eventCount
      : undefined,
    diagnosticEventCount: typeof value.diagnosticEventCount === "number"
      ? value.diagnosticEventCount
      : undefined,
    returnValue: value.returnValue,
    nonRefundableResourceFeeCharged:
      typeof value.nonRefundableResourceFeeCharged === "number"
        ? value.nonRefundableResourceFeeCharged
        : undefined,
    refundableResourceFeeCharged:
      typeof value.refundableResourceFeeCharged === "number"
        ? value.refundableResourceFeeCharged
        : undefined,
    rentFeeCharged:
      typeof value.rentFeeCharged === "number"
        ? value.rentFeeCharged
        : undefined,
    latestLedger:
      typeof value.latestLedger === "number"
        ? value.latestLedger
        : undefined,
    latestLedgerCloseTime:
      typeof value.latestLedgerCloseTime === "number"
        ? value.latestLedgerCloseTime
        : undefined,
    rpcStatus:
      typeof value.rpcStatus === "string" ? value.rpcStatus : undefined,
    simulationError:
      typeof value.simulationError === "string"
        ? value.simulationError
        : undefined,
    sourceReference:
      typeof value.sourceReference === "string"
        ? value.sourceReference
        : undefined,
  };
}

export function normalizeErrorEntry(
  raw: unknown,
): ErrorEntry | null {
  if (!isRecord(raw)) {
    return null;
  }

  const fingerprint = normalizeString(raw.fingerprint);
  const summary = normalizeString(raw.summary);
  const errorCategory = normalizeString(raw.errorCategory);
  const functionName = normalizeString(raw.functionName);
  const seenCount = typeof raw.seenCount === "number" && Number.isFinite(raw.seenCount)
    ? raw.seenCount
    : null;
  const firstSeen = normalizeTimestampString(raw.firstSeen);
  const lastSeen = normalizeTimestampString(raw.lastSeen);
  const likelyCause = normalizeString(raw.likelyCause);
  const suggestedFix = normalizeString(raw.suggestedFix);
  const detailedAnalysis = normalizeString(raw.detailedAnalysis);
  const modelId = normalizeString(raw.modelId);
  const exampleTxHash = normalizeString(raw.exampleTxHash);
  const resultKind = normalizeString(raw.resultKind);

  if (
    !fingerprint ||
    !summary ||
    !errorCategory ||
    !functionName ||
    seenCount === null ||
    !firstSeen ||
    !lastSeen ||
    !likelyCause ||
    !suggestedFix ||
    !detailedAnalysis ||
    !modelId ||
    !exampleTxHash ||
    !resultKind
  ) {
    return null;
  }

  const contractIds = normalizeStringArray(raw.contractIds);
  const txHashes = normalizeStringArray(raw.txHashes);
  const evidence = normalizeStringArray(raw.evidence);
  const relatedCodes = normalizeStringArray(raw.relatedCodes);
  const debugSteps = normalizeStringArray(raw.debugSteps);
  const exampleReadout = normalizeErrorReadout(
    raw.exampleReadout,
    resultKind,
    contractIds.length,
  );

  if (
    txHashes.length === 0 ||
    !Array.isArray(raw.errorSignatures) ||
    !Array.isArray(raw.sorobanOperationTypes) ||
    !exampleReadout
  ) {
    return null;
  }

  return {
    fingerprint,
    observationKinds: normalizeObservationKinds(raw.observationKinds),
    contractIds,
    functionName,
    errorSignatures: Array.isArray(raw.errorSignatures)
      ? raw.errorSignatures
        .filter((item): item is { type: string; code: string } =>
          isRecord(item) &&
          typeof item.type === "string" &&
          typeof item.code === "string"
        )
        .map((item) => ({ type: item.type, code: item.code }))
      : [],
    resultKind,
    sorobanOperationTypes: normalizeStringArray(raw.sorobanOperationTypes),
    summary,
    errorCategory,
    likelyCause,
    suggestedFix,
    detailedAnalysis,
    evidence,
    relatedCodes,
    debugSteps,
    confidence: normalizeConfidence(raw.confidence),
    modelId,
    seenCount,
    txHashes: [...new Set(txHashes)].slice(-MAX_TX_HASHES_PER_ENTRY),
    firstSeen,
    lastSeen,
    similarTo: typeof raw.similarTo === "string" ? raw.similarTo : undefined,
    exampleTxHash,
    exampleReadout,
    contractContext: typeof raw.contractContext === "string"
      ? raw.contractContext
      : undefined,
  };
}

// --- Error Entry (fingerprint-based, deduplicated) ---

export async function getErrorEntry(
  env: Env,
  fingerprint: string,
): Promise<ErrorEntry | null> {
  const object = await env.ERRORS_BUCKET.get(`errors/${fingerprint}.json`);
  if (!object) return null;
  const raw = await object.json();
  return normalizeErrorEntry(raw);
}

export async function storeSearchDocument(
  env: Env,
  entry: ErrorEntry,
): Promise<void> {
  const document = buildSearchDocument(entry);
  const metadata: Record<string, string> = {
    fingerprint: document.metadata.fingerprint,
    error_category: document.metadata.error_category,
    function_name: document.metadata.function_name,
    primary_contract: document.metadata.primary_contract,
    operation_type: document.metadata.operation_type,
  };
  await env.ERRORS_BUCKET.put(document.key, document.content, {
    httpMetadata: { contentType: "text/markdown" },
    customMetadata: metadata,
  });
}

export async function storeErrorEntry(
  env: Env,
  entry: ErrorEntry,
): Promise<void> {
  const normalized = normalizeErrorEntry(entry);
  if (!normalized) return;

  const key = `errors/${normalized.fingerprint}.json`;
  await env.ERRORS_BUCKET.put(key, JSON.stringify(normalized, null, 2), {
    httpMetadata: { contentType: "application/json" },
      customMetadata: {
        fingerprint: normalized.fingerprint,
        errorCategory: normalized.errorCategory,
        confidence: normalized.confidence,
        contractIds: normalized.contractIds.join(",").slice(0, 200),
        functionName: normalized.functionName,
        observationKinds: normalized.observationKinds.join(","),
        seenCount: String(normalized.seenCount),
        relatedCodes: normalized.relatedCodes.join(",").slice(0, 200),
        context: `${normalized.summary} Category: ${normalized.errorCategory}. Codes: ${normalized.relatedCodes.join(", ")}. Function: ${normalized.functionName}`.slice(0, 200),
    },
  });
  await storeSearchDocument(env, normalized);
}

/**
 * Increment the occurrence count on an existing error entry.
 * Deduplicates and keeps a sliding window of the most recent tx hashes.
 */
export async function bumpErrorEntry(
  env: Env,
  entry: ErrorEntry,
  txHash: string,
  ledgerCloseTime: string,
  observationKind: ObservationKind,
): Promise<void> {
  const normalized = normalizeErrorEntry(entry);
  if (!normalized) return;

  normalized.seenCount += 1;
  normalized.observationKinds = [
    ...new Set([...normalized.observationKinds, observationKind]),
  ];
  normalized.txHashes = [...normalized.txHashes.filter((h) => h !== txHash), txHash]
    .slice(-MAX_TX_HASHES_PER_ENTRY);
  normalized.lastSeen = ledgerCloseTime;
  await storeErrorEntry(env, normalized);
  await storeTxHashPointer(env, txHash, normalized.fingerprint);
}

export async function storeTxHashPointer(
  env: Env,
  txHash: string,
  fingerprint: string,
): Promise<void> {
  await env.CURSOR_KV.put(`${TX_FINGERPRINT_KV_PREFIX}${txHash}`, fingerprint);
}

export async function getFingerprintByTxHash(
  env: Env,
  txHash: string,
): Promise<string | null> {
  return env.CURSOR_KV.get(`${TX_FINGERPRINT_KV_PREFIX}${txHash}`);
}

export async function findErrorEntryByTxHash(
  env: Env,
  txHash: string,
): Promise<ErrorEntry | null> {
  const indexedFingerprint = await getFingerprintByTxHash(env, txHash);
  if (!indexedFingerprint) return null;
  return getErrorEntry(env, indexedFingerprint);
}

// --- Raw transaction storage (one per fingerprint, as reference example) ---

export async function storeExampleTransaction(
  env: Env,
  tx: FailedTransaction,
  fingerprint: string,
  contracts: ContractMetadata[] = [],
): Promise<void> {
  const key = `${REFERENCE_TRANSACTIONS_PREFIX}${fingerprint}.json`;
  const record: ExampleTransactionRecord = {
    fingerprint,
    storedAt: new Date().toISOString(),
    transaction: tx,
    contracts,
  };

  await env.ERRORS_BUCKET.put(key, JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      fingerprint,
      txHash: tx.txHash,
      functionName: tx.decoded.topLevelFunction,
      contractCount: String(contracts.length),
    },
  });
}

export async function getExampleTransaction(
  env: Env,
  fingerprint: string,
): Promise<ExampleTransactionRecord | null> {
  const object = await env.ERRORS_BUCKET.get(
    `${REFERENCE_TRANSACTIONS_PREFIX}${fingerprint}.json`,
  );
  if (!object) return null;
  return object.json();
}

export async function deleteExampleTransaction(
  env: Env,
  fingerprint: string,
): Promise<void> {
  await env.ERRORS_BUCKET.delete(`${REFERENCE_TRANSACTIONS_PREFIX}${fingerprint}.json`);
}

export async function deleteErrorEntryArtifacts(
  env: Env,
  fingerprint: string,
): Promise<void> {
  await env.ERRORS_BUCKET.delete(`errors/${fingerprint}.json`);
  await env.ERRORS_BUCKET.delete(`${SEARCH_DOCS_PREFIX}${fingerprint}.md`);
}

// --- Vector similarity (Vectorize-based semantic dedup) ---

async function generateEmbedding(
  env: Env,
  text: string,
): Promise<number[]> {
  const result: any = await env.AI.run(EMBEDDING_MODEL as any, {
    text: [text],
  });
  return result.data[0];
}

/**
 * Check Vectorize for a semantically similar existing error.
 * Returns the fingerprint of the most similar match, or null.
 */
export async function findSimilarError(
  env: Env,
  description: string,
): Promise<{ fingerprint: string; score: number } | null> {
  const embedding = await generateEmbedding(env, description);

  const matches = await env.VECTORIZE.query(embedding, {
    topK: 1,
    returnMetadata: "all",
  });

  if (
    matches.count > 0 &&
    matches.matches[0].score >= SIMILARITY_THRESHOLD
  ) {
    const meta = matches.matches[0].metadata as Record<string, string> | undefined;
    return {
      fingerprint: meta?.fingerprint ?? matches.matches[0].id,
      score: matches.matches[0].score,
    };
  }

  return null;
}

/**
 * Insert a new error's embedding into Vectorize for future similarity checks.
 */
export async function indexErrorVector(
  env: Env,
  fingerprint: string,
  description: string,
  metadata: Record<string, string>,
): Promise<void> {
  const embedding = await generateEmbedding(env, description);

  await env.VECTORIZE.upsert([
    {
      id: fingerprint,
      values: embedding,
      metadata: { fingerprint, ...metadata },
    },
  ]);
}

// --- KV Cursor ---

export async function getLastProcessedLedger(
  env: Env,
): Promise<number | null> {
  const value = await env.CURSOR_KV.get(CURSOR_KEY);
  if (!value) return null;
  const num = parseInt(value, 10);
  return isNaN(num) ? null : num;
}

export async function setLastProcessedLedger(
  env: Env,
  sequence: number,
): Promise<void> {
  await env.CURSOR_KV.put(CURSOR_KEY, String(sequence));
}

export function resetStorageStateForTests(): void {
  // No-op placeholder for test parity.
}

export async function storeAsyncJob(
  env: Env,
  job: AsyncJob,
): Promise<void> {
  await getWorkflowArtifactsBucket(env).put(
    `${JOBS_PREFIX}${job.jobId}.json`,
    JSON.stringify(job, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        jobId: job.jobId,
        status: job.status,
        kind: job.kind,
        fingerprint:
          job.result && "fingerprint" in job.result
            ? job.result.fingerprint
            : "",
        sourceReference: job.sourceReference ?? "",
      },
    },
  );
}

export async function getAsyncJob(
  env: Env,
  jobId: string,
): Promise<AsyncJob | null> {
  const object = await getWorkflowArtifactsBucket(env).get(`${JOBS_PREFIX}${jobId}.json`);
  if (!object) return null;
  return await object.json() as AsyncJob;
}

export async function storeJobInput(
  env: Env,
  jobId: string,
  input: AsyncJobInput,
): Promise<void> {
  await getWorkflowArtifactsBucket(env).put(
    `${JOB_INPUTS_PREFIX}${jobId}.json`,
    JSON.stringify(input, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );
}

export async function getJobInput(
  env: Env,
  jobId: string,
): Promise<AsyncJobInput | null> {
  const object = await getWorkflowArtifactsBucket(env).get(`${JOB_INPUTS_PREFIX}${jobId}.json`);
  if (!object) return null;
  return await object.json() as AsyncJobInput;
}

export async function storeJobResultArtifact(
  env: Env,
  jobId: string,
  payload: unknown,
): Promise<string> {
  const key = `${JOB_RESULTS_PREFIX}${jobId}.json`;
  await getWorkflowArtifactsBucket(env).put(key, JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  return key;
}

export async function storeStagedFailedTransaction(
  env: Env,
  jobId: string,
  txHash: string,
  transaction: FailedTransaction,
): Promise<string> {
  const safeHash = txHash.replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = `${JOB_STAGING_PREFIX}${jobId}/transactions/${safeHash}.json`;
  await getWorkflowArtifactsBucket(env).put(key, JSON.stringify(transaction, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  return key;
}

export async function getStagedFailedTransaction(
  env: Env,
  key: string,
): Promise<FailedTransaction | null> {
  const object = await getWorkflowArtifactsBucket(env).get(key);
  if (!object) return null;
  return await object.json() as FailedTransaction;
}

export async function findStagedFailedTransactionByTxHash(
  env: Env,
  txHash: string,
): Promise<FailedTransaction | null> {
  const safeHash = txHash.replace(/[^a-zA-Z0-9_-]/g, "_");
  const suffix = `/transactions/${safeHash}.json`;
  const bucket = getWorkflowArtifactsBucket(env);
  let cursor: string | undefined;

  while (true) {
    const listed = await bucket.list({
      prefix: JOB_STAGING_PREFIX,
      cursor,
      limit: 1000,
    });
    const match = listed.objects.find((object) => object.key.endsWith(suffix));
    if (match) {
      return getStagedFailedTransaction(env, match.key);
    }
    if (!listed.truncated) {
      return null;
    }
    cursor = listed.cursor;
  }
}

export async function storeJobStepResult(
  env: Env,
  jobId: string,
  stepName: string,
  result: unknown,
): Promise<void> {
  await getWorkflowArtifactsBucket(env).put(
    `${JOB_STAGING_PREFIX}${jobId}/step-results/${stepName}.json`,
    JSON.stringify(result, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );
}

export async function getJobStepResult<T>(
  env: Env,
  jobId: string,
  stepName: string,
): Promise<T | null> {
  const object = await getWorkflowArtifactsBucket(env).get(
    `${JOB_STAGING_PREFIX}${jobId}/step-results/${stepName}.json`,
  );
  if (!object) return null;
  return await object.json() as T;
}

export async function cleanupTransientArtifactsForJob(
  env: Env,
  jobId: string,
): Promise<void> {
  const bucket = getWorkflowArtifactsBucket(env);
  await bucket.delete(`${JOB_INPUTS_PREFIX}${jobId}.json`);
  await deleteBucketPrefix(bucket, `${JOB_STAGING_PREFIX}${jobId}/`);
}

export async function cleanupRetainedJobArtifacts(
  env: Env,
  retentionHours = Number(env.JOB_RETENTION_HOURS ?? "72"),
): Promise<{ deletedJobs: number; deletedArtifacts: number }> {
  const bucket = getWorkflowArtifactsBucket(env);
  const cutoff = Date.now() - Math.max(retentionHours, 1) * 60 * 60 * 1000;
  const listed = await bucket.list({ prefix: JOBS_PREFIX, limit: 1000 });

  let deletedJobs = 0;
  let deletedArtifacts = 0;

  for (const object of listed.objects) {
    if (object.uploaded.getTime() > cutoff) continue;
    const body = await bucket.get(object.key);
    if (!body) continue;

    const job = await body.json() as AsyncJob;
    if (!isTerminalAsyncJobStatus(job.status)) continue;

    await bucket.delete(object.key);
    deletedJobs += 1;

    await bucket.delete(`${JOB_RESULTS_PREFIX}${job.jobId}.json`);
    deletedArtifacts += 1;
    await bucket.delete(`${JOB_INPUTS_PREFIX}${job.jobId}.json`);
    deletedArtifacts += 1;
    deletedArtifacts += await deleteBucketPrefix(bucket, `${JOB_STAGING_PREFIX}${job.jobId}/`);
  }

  return { deletedJobs, deletedArtifacts };
}

export async function setActiveRecurringScanRecord(
  env: Env,
  record: ActiveRecurringScanRecord | null,
): Promise<void> {
  if (!record) {
    await env.CURSOR_KV.delete(ACTIVE_RECURRING_SCAN_KEY);
    return;
  }
  await env.CURSOR_KV.put(ACTIVE_RECURRING_SCAN_KEY, JSON.stringify(record));
}

export async function getActiveRecurringScanRecord(
  env: Env,
): Promise<ActiveRecurringScanRecord | null> {
  const value = await env.CURSOR_KV.get(ACTIVE_RECURRING_SCAN_KEY);
  if (!value) return null;
  try {
    return JSON.parse(value) as ActiveRecurringScanRecord;
  } catch {
    return null;
  }
}

export async function setActiveDirectJob(
  env: Env,
  txHash: string,
  jobId: string | null,
): Promise<void> {
  const key = `${ACTIVE_DIRECT_JOB_PREFIX}${txHash}`;
  if (!jobId) {
    await env.CURSOR_KV.delete(key);
    return;
  }
  await env.CURSOR_KV.put(key, jobId);
}

export async function getActiveDirectJob(
  env: Env,
  txHash: string,
): Promise<string | null> {
  return env.CURSOR_KV.get(`${ACTIVE_DIRECT_JOB_PREFIX}${txHash}`);
}
