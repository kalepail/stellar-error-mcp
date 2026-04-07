import {
  findStagedFailedTransactionByTxHash,
  getErrorEntry,
  getExampleTransaction,
  storeErrorEntry,
  storeExampleTransaction,
} from "./storage.js";
import type { Env, ExampleTransactionRecord, FailedTransaction } from "./types.js";

function pickReferenceTxHash(exampleTxHash: string, txHashes: string[]): string | null {
  if (exampleTxHash.trim()) return exampleTxHash;
  return txHashes.at(-1) ?? txHashes[0] ?? null;
}

async function findArchivedTransactionNearObservation(
  env: Env,
  txHash: string,
  observedAt: string,
  rpcContext?: FailedTransaction["rpcContext"],
): Promise<FailedTransaction | null> {
  const observedMs = new Date(observedAt).getTime();
  if (Number.isNaN(observedMs)) return null;

  const ageMs = Math.abs(Date.now() - observedMs);
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (ageMs > oneDayMs) return null;

  const { getLatestLedger, scanForFailedTransactions } = await import("./stellar.js");
  const latestLedger = await getLatestLedger(env, rpcContext);
  const estimatedLedgersAgo = Math.ceil(ageMs / 5000);
  const searchSpan = Math.min(Math.max(estimatedLedgersAgo + 600, 600), 4000);
  const startLedger = Math.max(1, latestLedger - searchSpan);
  const result = await scanForFailedTransactions(
    env,
    startLedger,
    searchSpan + 1,
    20_000,
    rpcContext,
  );

  return result.transactions.find((transaction) => transaction.txHash === txHash) ?? null;
}

export async function ensureExampleTransaction(
  env: Env,
  fingerprint: string,
  preferredTransaction?: FailedTransaction,
): Promise<ExampleTransactionRecord | null> {
  const existing = await getExampleTransaction(env, fingerprint);
  if (existing) return existing;

  const entry = await getErrorEntry(env, fingerprint);
  if (!entry) return null;

  const txHash = pickReferenceTxHash(entry.exampleTxHash, entry.txHashes);
  if (!txHash) return null;
  const preferredRpcContext = preferredTransaction?.rpcContext;

  const transaction = preferredTransaction
    ?? await findStagedFailedTransactionByTxHash(env, txHash)
    ?? await import("./stellar.js")
      .then(({ getFailedTransactionByHash }) =>
        getFailedTransactionByHash(env, txHash, preferredRpcContext)
      )
    ?? await findArchivedTransactionNearObservation(
      env,
      txHash,
      entry.firstSeen,
      preferredRpcContext,
    );
  if (!transaction) return null;

  let contracts:
    | Awaited<ReturnType<typeof import("./contracts.js")["fetchContractsForError"]>>
    | undefined;
  if (transaction.contractIds.length > 0) {
    try {
      contracts = await import("./contracts.js")
        .then(({ fetchContractsForError }) =>
          fetchContractsForError(env, transaction.contractIds, transaction.rpcContext)
        );
    } catch {
      contracts = undefined;
    }
  }

  await storeExampleTransaction(
    env,
    transaction,
    fingerprint,
    contracts ? [...contracts.values()] : [],
  );

  await storeErrorEntry(env, entry);
  return getExampleTransaction(env, fingerprint);
}
