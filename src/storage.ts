import type {
  ContractMetadata,
  DirectErrorJob,
  Env,
  ErrorEntry,
  ErrorReadout,
  ExampleTransactionRecord,
  FailedTransaction,
  ObservationKind,
} from "./types.js";
import { buildSearchDocument } from "./ai-search.js";

const CURSOR_KEY = "last_processed_ledger";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const SIMILARITY_THRESHOLD = 0.90;
const MAX_TX_HASHES_PER_ENTRY = 50;
const JOBS_PREFIX = "jobs/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
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
  const firstSeen = normalizeString(raw.firstSeen);
  const lastSeen = normalizeString(raw.lastSeen);
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
  await env.ERRORS_BUCKET.put(
    `tx-index/${txHash}.json`,
    JSON.stringify({ fingerprint }, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { txHash, fingerprint },
    },
  );
}

export async function getFingerprintByTxHash(
  env: Env,
  txHash: string,
): Promise<string | null> {
  const object = await env.ERRORS_BUCKET.get(`tx-index/${txHash}.json`);
  if (!object) return null;

  const raw = await object.json();
  if (!isRecord(raw) || typeof raw.fingerprint !== "string" || raw.fingerprint.length === 0) {
    return null;
  }

  return raw.fingerprint;
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
  const key = `examples/${fingerprint}.json`;
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
  const object = await env.ERRORS_BUCKET.get(`examples/${fingerprint}.json`);
  if (!object) return null;
  return object.json();
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

export async function storeDirectErrorJob(
  env: Env,
  job: DirectErrorJob,
): Promise<void> {
  await env.ERRORS_BUCKET.put(
    `${JOBS_PREFIX}${job.jobId}.json`,
    JSON.stringify(job, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        jobId: job.jobId,
        status: job.status,
        kind: job.kind,
        fingerprint: job.result?.fingerprint ?? "",
        sourceReference: job.sourceReference ?? "",
      },
    },
  );
}

export async function getDirectErrorJob(
  env: Env,
  jobId: string,
): Promise<DirectErrorJob | null> {
  const object = await env.ERRORS_BUCKET.get(`${JOBS_PREFIX}${jobId}.json`);
  if (!object) return null;
  return await object.json() as DirectErrorJob;
}
