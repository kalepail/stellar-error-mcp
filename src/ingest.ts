import type {
  ContractMetadata,
  Env,
  ErrorEntry,
  ExampleTransactionRecord,
  FailedTransaction,
} from "./types.js";
import {
  bumpErrorEntry,
  findSimilarError,
  getErrorEntry,
  getExampleTransaction,
  indexErrorVector,
  storeErrorEntry,
  storeExampleTransaction,
  storeTxHashPointer,
} from "./storage.js";
import { analyzeFailedTransaction } from "./analysis.js";
import { buildErrorDescription, buildFingerprint } from "./fingerprint.js";
import { buildContractContext, fetchContractsForError } from "./contracts.js";
import { attachDeepDecodedViews } from "./transaction.js";

export interface IngestFailedTransactionResult {
  status: "duplicate" | "new";
  fingerprint: string;
  entry: ErrorEntry;
  example: ExampleTransactionRecord | null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logWarn(event: string, fields: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
}

function logInfo(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

export async function ingestFailedTransaction(
  env: Env,
  tx: FailedTransaction,
): Promise<IngestFailedTransactionResult> {
  const { fingerprint, functionName, errorSignatures } =
    await buildFingerprint(tx);

  const existing = await getErrorEntry(env, fingerprint);
  if (existing) {
    await bumpErrorEntry(
      env,
      existing,
      tx.txHash,
      tx.ledgerCloseTime,
      tx.observationKind,
    );
    logInfo("ingest.duplicate", {
      fingerprint,
      txHash: tx.txHash,
      observationKind: tx.observationKind,
      seenCount: existing.seenCount + 1,
    });
    return {
      status: "duplicate",
      fingerprint,
      entry: {
        ...existing,
        observationKinds: [
          ...new Set([...existing.observationKinds, tx.observationKind]),
        ],
        seenCount: existing.seenCount + 1,
        txHashes: [...existing.txHashes.filter((h) => h !== tx.txHash), tx.txHash].slice(-50),
        lastSeen: tx.ledgerCloseTime,
      },
      example: await getExampleTransaction(env, fingerprint),
    };
  }

  const descriptionContracts = tx.primaryContractIds.length > 0
    ? tx.primaryContractIds
    : tx.contractIds;
  const description = buildErrorDescription(
    descriptionContracts,
    functionName,
    errorSignatures,
    tx.resultKind,
  );

  let similarTo: string | undefined;
  try {
    const similar = await findSimilarError(env, description);
    if (similar) {
      similarTo = similar.fingerprint;
      logInfo("ingest.similar_match", {
        fingerprint,
        txHash: tx.txHash,
        observationKind: tx.observationKind,
        similarTo,
        score: Number(similar.score.toFixed(3)),
      });
    }
  } catch (error) {
    logWarn("ingest.similarity_skipped", {
      txHash: tx.txHash,
      observationKind: tx.observationKind,
      error: formatError(error),
    });
  }

  let contracts: Map<string, ContractMetadata> | undefined;
  let contractContext: string | undefined;
  if (tx.contractIds.length > 0) {
    try {
      contracts = await fetchContractsForError(env, tx.contractIds);
      contractContext = buildContractContext(contracts);
    } catch (error) {
      logWarn("ingest.contract_fetch_skipped", {
        txHash: tx.txHash,
        observationKind: tx.observationKind,
        error: formatError(error),
      });
    }
  }

  const enrichedTx = {
    ...tx,
    decoded: attachDeepDecodedViews(
      tx.decoded,
      tx.envelopeJson,
      tx.processingJson,
    ),
  };

  const analysis = await analyzeFailedTransaction(env, enrichedTx, contracts);

  const entry: ErrorEntry = {
    fingerprint,
    observationKinds: [enrichedTx.observationKind],
    contractIds: enrichedTx.contractIds,
    functionName,
    errorSignatures,
    resultKind: enrichedTx.resultKind,
    sorobanOperationTypes: enrichedTx.sorobanOperationTypes,
    summary: analysis.summary,
    errorCategory: analysis.errorCategory,
    likelyCause: analysis.likelyCause,
    suggestedFix: analysis.suggestedFix,
    detailedAnalysis: analysis.detailedAnalysis,
    evidence: analysis.evidence,
    relatedCodes: analysis.relatedCodes,
    debugSteps: analysis.debugSteps,
    confidence: analysis.confidence,
    modelId: analysis.modelId,
    seenCount: 1,
    txHashes: [enrichedTx.txHash],
    firstSeen: enrichedTx.ledgerCloseTime,
    lastSeen: enrichedTx.ledgerCloseTime,
    similarTo,
    exampleTxHash: enrichedTx.txHash,
    exampleReadout: enrichedTx.readout,
    contractContext: contractContext ?? undefined,
  };

  await storeErrorEntry(env, entry);
  await storeTxHashPointer(env, enrichedTx.txHash, fingerprint);
  await storeExampleTransaction(
    env,
    enrichedTx,
    fingerprint,
    contracts ? [...contracts.values()] : [],
  );

  try {
    await indexErrorVector(env, fingerprint, description, {
      errorCategory: entry.errorCategory,
      functionName,
      contractIds: enrichedTx.contractIds.join(",").slice(0, 200),
      relatedCodes: entry.relatedCodes.join(",").slice(0, 200),
    });
  } catch (error) {
    logWarn("ingest.vector_index_skipped", {
      fingerprint,
      txHash: tx.txHash,
      observationKind: tx.observationKind,
      error: formatError(error),
    });
  }

  logInfo("ingest.new_error", {
    fingerprint,
    txHash: tx.txHash,
    observationKind: tx.observationKind,
    resultKind: tx.resultKind,
    errorCategory: entry.errorCategory,
    confidence: entry.confidence,
    similarTo: similarTo ?? null,
  });

  return {
    status: "new",
    fingerprint,
    entry,
    example: await getExampleTransaction(env, fingerprint),
  };
}
