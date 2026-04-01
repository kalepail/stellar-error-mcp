import type {
  AnalysisResult,
  ContractMetadata,
  Env,
  ErrorEntry,
  ExampleTransactionRecord,
  FailedTransaction,
} from "./types.js";

const CURSOR_KEY = "last_processed_ledger";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const SIMILARITY_THRESHOLD = 0.90;
const MAX_TX_HASHES_PER_ENTRY = 50;

// --- Error Entry (fingerprint-based, deduplicated) ---

export async function getErrorEntry(
  env: Env,
  fingerprint: string,
): Promise<ErrorEntry | null> {
  const object = await env.ERRORS_BUCKET.get(`errors/${fingerprint}.json`);
  if (!object) return null;
  return object.json();
}

export async function storeErrorEntry(
  env: Env,
  entry: ErrorEntry,
): Promise<void> {
  const key = `errors/${entry.fingerprint}.json`;
  await env.ERRORS_BUCKET.put(key, JSON.stringify(entry, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      fingerprint: entry.fingerprint,
      errorCategory: entry.errorCategory,
      confidence: entry.confidence,
      contractIds: entry.contractIds.join(",").slice(0, 200),
      functionName: entry.functionName,
      seenCount: String(entry.seenCount),
      relatedCodes: entry.relatedCodes.join(",").slice(0, 200),
      context: `${entry.summary} Category: ${entry.errorCategory}. Codes: ${entry.relatedCodes.join(", ")}. Function: ${entry.functionName}`.slice(0, 200),
    },
  });
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
): Promise<void> {
  entry.seenCount += 1;
  entry.txHashes = [...entry.txHashes.filter((hash) => hash !== txHash), txHash]
    .slice(-MAX_TX_HASHES_PER_ENTRY);
  entry.lastSeen = ledgerCloseTime;
  await storeErrorEntry(env, entry);
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

// --- Backward-compatible accessors for MCP tools ---

export async function getRawTransaction(
  env: Env,
  txHash: string,
): Promise<FailedTransaction | null> {
  // Check legacy raw/ path first, then search error entries by txHash
  const legacy = await env.ERRORS_BUCKET.get(`raw/${txHash}.json`);
  if (legacy) return legacy.json();
  return null;
}

export async function getAnalysis(
  env: Env,
  txHash: string,
): Promise<AnalysisResult | null> {
  // Check legacy analysis/ path
  const legacy = await env.ERRORS_BUCKET.get(`analysis/${txHash}.json`);
  if (legacy) return legacy.json();
  return null;
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
