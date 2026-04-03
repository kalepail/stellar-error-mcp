import { xdr } from "@stellar/stellar-sdk";
import type { Env, FailedTransaction, ErrorReadout, ScanResult } from "./types.js";
import { buildDecodedTransactionContext } from "./transaction.js";
import { buildRpcUrl, getRealtimeRpcEndpoint, getRpcAuthMode, rpcRequest } from "./rpc.js";

const SOROBAN_OPERATION_KEYS = new Set([
  "invoke_host_function",
  "restore_footprint",
  "extend_footprint_ttl",
]);

const SUCCESS_KINDS = new Set(["tx_success", "tx_fee_bump_inner_success"]);

function xdrToJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

// --- RPC Client ---

function buildLedgersPayload(
  startLedger: number,
  limit: number,
  cursor?: string,
): string {
  if (cursor) {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "getLedgers",
      params: {
        pagination: { cursor, limit },
        xdrFormat: "json",
      },
    });
  }
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    method: "getLedgers",
    params: {
      startLedger,
      pagination: { limit },
      xdrFormat: "json",
    },
  });
}

async function fetchLedgerRange(
  env: Env,
  startLedger: number,
  limit: number,
  cursor?: string,
): Promise<any> {
  const authMode = getRpcAuthMode(env);
  const payload = buildLedgersPayload(startLedger, limit, cursor);
  const response = await fetch(
    buildRpcUrl(
      env.STELLAR_ARCHIVE_RPC_ENDPOINT,
      env.STELLAR_ARCHIVE_RPC_TOKEN,
      authMode,
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authMode === "path"
          ? {}
          : { Authorization: `Bearer ${env.STELLAR_ARCHIVE_RPC_TOKEN}` }),
      },
      body: payload,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Archive RPC HTTP ${response.status}: ${await response.text()}`,
    );
  }

  const json: any = await response.json();
  if (json.error) {
    const errMsg = json.error.message || JSON.stringify(json.error);
    // If we've reached the tip of the chain, return empty result
    if (
      typeof errMsg === "string" &&
      /\b(startLedger|cursor)\b.*\bmust be between\b|\bmust be between\b.*\b(startLedger|cursor)\b/i.test(
        errMsg,
      )
    ) {
      return { ledgers: [], cursor: undefined };
    }
    throw new Error(`Archive RPC error: ${errMsg}`);
  }

  return json.result;
}

// --- Transaction Extraction (port of root.zig) ---

function collectLedgerTransactions(metadataJson: any): any[] {
  const transactions: any[] = [];
  const v2 = metadataJson?.v2;
  if (!v2) return transactions;

  const phases = v2?.tx_set?.v1?.phases;
  if (!Array.isArray(phases)) return transactions;

  for (const phase of phases) {
    // Phase v0: groups → txset_comp_txs_maybe_discounted_fee.txs
    if (phase.v0 && Array.isArray(phase.v0)) {
      for (const group of phase.v0) {
        const txs = group?.txset_comp_txs_maybe_discounted_fee?.txs;
        if (Array.isArray(txs)) {
          transactions.push(...txs);
        }
      }
    }

    // Phase v1: execution_stages (recursive flatten)
    if (phase.v1?.execution_stages) {
      appendLedgerTransactionItems(transactions, phase.v1.execution_stages);
    }
  }

  return transactions;
}

function appendLedgerTransactionItems(
  transactions: any[],
  value: unknown,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      appendLedgerTransactionItems(transactions, item);
    }
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.tx !== undefined || obj.tx_fee_bump !== undefined) {
      transactions.push(value);
    }
  }
}

function getLedgerTransactionProcessing(metadataJson: any): any[] {
  return metadataJson?.v2?.tx_processing ?? [];
}

function getProcessingResultKind(processingResult: any): string | null {
  const txResult = processingResult?.result;
  const outcome = txResult?.result;
  if (!outcome || typeof outcome !== "object") return null;
  const keys = Object.keys(outcome);
  return keys.length > 0 ? keys[0] : null;
}

function containsSorobanOperation(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSorobanOperation);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (SOROBAN_OPERATION_KEYS.has(key)) return true;
      if (containsSorobanOperation(obj[key])) return true;
    }
  }
  return false;
}

function hasNonNullKey(value: unknown, wantedKey: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasNonNullKey(item, wantedKey));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (key === wantedKey && val !== null) return true;
      if (hasNonNullKey(val, wantedKey)) return true;
    }
  }
  return false;
}

function isSorobanLedgerTransaction(
  txEntry: any,
  processingValue: any,
): boolean {
  return (
    containsSorobanOperation(txEntry) ||
    hasNonNullKey(processingValue, "soroban_meta")
  );
}

function getLedgerTransactionOperations(txValue: any): any[] {
  if (txValue?.tx) {
    return txValue.tx.tx?.operations ?? [];
  }
  if (txValue?.tx_fee_bump) {
    return (
      txValue.tx_fee_bump.tx?.inner_tx?.tx?.tx?.operations ?? []
    );
  }
  return [];
}

function collectOperationTypes(txValue: any): string[] {
  const types = new Set<string>();
  const operations = getLedgerTransactionOperations(txValue);
  for (const op of operations) {
    if (op?.body && typeof op.body === "object") {
      for (const key of Object.keys(op.body)) {
        types.add(key);
      }
    }
  }
  return [...types];
}

function collectSorobanOperationTypes(txValue: any): string[] {
  return collectOperationTypes(txValue).filter((t) =>
    SOROBAN_OPERATION_KEYS.has(t),
  );
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function getNestedArrayLength(
  value: unknown,
  path: string[],
): number | undefined {
  const nested = getNestedValue(value, path);
  return Array.isArray(nested) ? nested.length : undefined;
}

function extractSourceAccount(txValue: any): string | undefined {
  if (txValue?.tx) {
    return txValue.tx?.tx?.source_account;
  }
  if (txValue?.tx_fee_bump) {
    return txValue.tx_fee_bump?.tx?.inner_tx?.tx?.tx?.source_account;
  }
  return undefined;
}

function extractFeeSourceAccount(txValue: any): string | undefined {
  if (txValue?.tx_fee_bump) {
    return txValue.tx_fee_bump?.tx?.fee_source;
  }
  return undefined;
}

function buildErrorReadout(
  txValue: any,
  processingValue: any,
  resultKind: string,
  invokeCalls: any[],
  contractIds: string[],
): ErrorReadout {
  const readout: ErrorReadout = {
    observationKind: "ledger_scan",
    resultKind,
    feeBump: txValue?.tx_fee_bump !== undefined,
    invokeCallCount: invokeCalls.length,
    contractCount: contractIds.length,
    hasSorobanMeta: hasNonNullKey(processingValue, "soroban_meta"),
    hasEvents: hasNonNullKey(processingValue, "events"),
    hasDiagnosticEvents: hasNonNullKey(processingValue, "diagnostic_events"),
  };

  const eventCount = getNestedArrayLength(processingValue, [
    "tx_apply_processing",
    "v4",
    "events",
  ]);
  if (eventCount !== undefined) readout.eventCount = eventCount;

  const diagCount = getNestedArrayLength(processingValue, [
    "tx_apply_processing",
    "v4",
    "diagnostic_events",
  ]);
  if (diagCount !== undefined) readout.diagnosticEventCount = diagCount;

  const returnValue = getNestedValue(processingValue, [
    "tx_apply_processing",
    "v4",
    "soroban_meta",
    "return_value",
  ]);
  if (returnValue !== undefined && returnValue !== null)
    readout.returnValue = returnValue;

  const nonRefundable = getNestedValue(processingValue, [
    "tx_apply_processing",
    "v4",
    "soroban_meta",
    "ext",
    "v1",
    "total_non_refundable_resource_fee_charged",
  ]);
  if (typeof nonRefundable === "number")
    readout.nonRefundableResourceFeeCharged = nonRefundable;

  const refundable = getNestedValue(processingValue, [
    "tx_apply_processing",
    "v4",
    "soroban_meta",
    "ext",
    "v1",
    "total_refundable_resource_fee_charged",
  ]);
  if (typeof refundable === "number")
    readout.refundableResourceFeeCharged = refundable;

  const rent = getNestedValue(processingValue, [
    "tx_apply_processing",
    "v4",
    "soroban_meta",
    "ext",
    "v1",
    "rent_fee_charged",
  ]);
  if (typeof rent === "number") readout.rentFeeCharged = rent;

  const source = extractSourceAccount(txValue);
  if (source) readout.sourceAccount = source;

  const feeSource = extractFeeSourceAccount(txValue);
  if (feeSource) readout.feeSourceAccount = feeSource;

  return readout;
}

function buildFailedSorobanTransaction(
  txEntry: any,
  processing: any,
  ledgerSequence: number | string,
  ledgerCloseTime: string | number,
): FailedTransaction | null {
  const txHash = processing?.result?.transaction_hash;
  const resultKind = getProcessingResultKind(processing?.result);
  if (!resultKind || SUCCESS_KINDS.has(resultKind)) return null;
  if (!isSorobanLedgerTransaction(txEntry, processing)) return null;
  if (typeof txHash !== "string" || txHash.length === 0) return null;

  const decoded = buildDecodedTransactionContext(txEntry, processing);
  const operationTypes = collectOperationTypes(txEntry);
  const sorobanOperationTypes = collectSorobanOperationTypes(txEntry);
  const primaryContractIds = [
    ...new Set(
      decoded.invokeCalls
        .map((call) =>
          typeof call.contractId === "string" ? call.contractId : null
        )
        .filter((value): value is string => value !== null && value.length > 0),
    ),
  ];
  const contractIds = [
    ...new Set(
      [...primaryContractIds, ...decoded.touchedContractIds]
        .filter((value) => value.length > 0),
    ),
  ];

  const readout = buildErrorReadout(
    txEntry,
    processing,
    resultKind,
    decoded.invokeCalls,
    contractIds,
  );

  return {
    observationKind: "ledger_scan",
    txHash,
    ledgerSequence: typeof ledgerSequence === "number" ? ledgerSequence : parseInt(ledgerSequence),
    ledgerCloseTime: String(ledgerCloseTime),
    resultKind,
    soroban: true,
    primaryContractIds,
    contractIds,
    operationTypes,
    sorobanOperationTypes,
    diagnosticEvents: decoded.diagnosticEvents,
    envelopeJson: txEntry,
    processingJson: processing,
    decoded,
    readout,
  };
}

function extractFailedSorobanTransactions(
  ledgers: any[],
): FailedTransaction[] {
  const failed: FailedTransaction[] = [];

  for (const ledger of ledgers) {
    const metadataJson = ledger.metadataJson;
    if (!metadataJson) continue;

    const txEntries = collectLedgerTransactions(metadataJson);
    const txProcessing = getLedgerTransactionProcessing(metadataJson);
    const txCount = Math.min(txEntries.length, txProcessing.length);
    if (txCount === 0) continue;

    const ledgerSequence = ledger.sequence;
    const ledgerCloseTime = ledger.ledgerCloseTime;

    for (let i = 0; i < txCount; i++) {
      try {
        const built = buildFailedSorobanTransaction(
          txEntries[i],
          txProcessing[i],
          ledgerSequence,
          ledgerCloseTime,
        );
        if (built) {
          failed.push(built);
        }
      } catch {
        continue;
      }
    }
  }

  return failed;
}

function parseDiagnosticEventsXdr(events: unknown): unknown[] {
  if (!Array.isArray(events)) return [];
  return events.flatMap((item) => {
    if (typeof item !== "string" || !item.length) return [];
    try {
      return [xdrToJson(xdr.DiagnosticEvent.fromXDR(item, "base64"))];
    } catch {
      return [];
    }
  });
}

function normalizeTransactionMeta(meta: unknown, diagnosticEvents: unknown[]): unknown {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {
      v4: {
        operations: [],
        events: [],
        diagnostic_events: diagnosticEvents,
        soroban_meta: null,
      },
    };
  }

  const candidate = JSON.parse(JSON.stringify(meta)) as Record<string, unknown>;
  if ("v4" in candidate && candidate.v4 && typeof candidate.v4 === "object") {
    const v4 = candidate.v4 as Record<string, unknown>;
    if (!Array.isArray(v4.diagnostic_events)) {
      v4.diagnostic_events = diagnosticEvents;
    }
    if (!Array.isArray(v4.events)) {
      v4.events = [];
    }
    if (!Array.isArray(v4.operations)) {
      v4.operations = [];
    }
    if (!("soroban_meta" in v4)) {
      v4.soroban_meta = null;
    }
    return candidate;
  }

  return {
    v4: {
      operations: [],
      events: [],
      diagnostic_events: diagnosticEvents,
      soroban_meta: null,
    },
  };
}

export async function getFailedTransactionByHash(
  env: Env,
  txHash: string,
): Promise<FailedTransaction | null> {
  const result = await rpcRequest({
    endpoint: getRealtimeRpcEndpoint(env),
    token: env.STELLAR_ARCHIVE_RPC_TOKEN,
    authMode: getRpcAuthMode(env),
    method: "getTransaction",
    params: {
      hash: txHash,
      xdrFormat: "base64",
    },
  });

  if (!result || result.status === "NOT_FOUND" || result.status !== "FAILED") {
    return null;
  }

  if (
    typeof result.envelopeXdr !== "string" ||
    typeof result.resultXdr !== "string" ||
    (typeof result.ledger !== "number" && typeof result.ledger !== "string")
  ) {
    return null;
  }

  const envelopeJson = xdrToJson(
    xdr.TransactionEnvelope.fromXDR(result.envelopeXdr, "base64"),
  );
  const resultJson = xdrToJson(
    xdr.TransactionResult.fromXDR(result.resultXdr, "base64"),
  ) as Record<string, unknown>;
  const metaJson = typeof result.resultMetaXdr === "string"
    ? xdrToJson(xdr.TransactionMeta.fromXDR(result.resultMetaXdr, "base64"))
    : null;
  const diagnosticEvents = parseDiagnosticEventsXdr(result.diagnosticEventsXdr);

  const processing = {
    result: {
      transaction_hash: txHash,
      result: resultJson ?? {},
    },
    tx_apply_processing: normalizeTransactionMeta(metaJson, diagnosticEvents),
  };

  return buildFailedSorobanTransaction(
    envelopeJson,
    processing,
    result.ledger,
    typeof result.createdAt === "number"
      ? result.createdAt
      : result.latestLedgerCloseTime ?? new Date().toISOString(),
  );
}

// --- Scan Orchestrator ---

const LEDGER_PAGE_SIZE = 5;
const MAX_FAILED_PER_CYCLE = 500;

export async function scanForFailedTransactions(
  env: Env,
  startLedger: number,
  maxLedgers: number,
  maxFailed?: number,
): Promise<ScanResult> {
  const allFailed: FailedTransaction[] = [];
  let cursor: string | undefined;
  let pagesScanned = 0;
  let ledgersScanned = 0;
  let lastLedgerProcessed = startLedger;
  const maxPages = Math.ceil(maxLedgers / LEDGER_PAGE_SIZE);
  const failLimit = maxFailed ?? MAX_FAILED_PER_CYCLE;

  while (pagesScanned < maxPages && allFailed.length < failLimit) {
    pagesScanned++;

    const result = await fetchLedgerRange(
      env,
      startLedger,
      LEDGER_PAGE_SIZE,
      cursor,
    );

    const ledgers = result.ledgers ?? [];
    ledgersScanned += ledgers.length;

    const failed = extractFailedSorobanTransactions(ledgers);
    allFailed.push(...failed);

    // Track the highest ledger sequence we've seen
    for (const ledger of ledgers) {
      const seq =
        typeof ledger.sequence === "number"
          ? ledger.sequence
          : parseInt(ledger.sequence);
      if (seq > lastLedgerProcessed) lastLedgerProcessed = seq;
    }

    cursor = result.cursor ?? undefined;
    if (!cursor || ledgers.length === 0) break;
  }

  return {
    transactions: allFailed.slice(0, failLimit),
    lastLedgerProcessed,
    pagesScanned,
    ledgersScanned,
  };
}

export async function getLatestLedger(env: Env): Promise<number> {
  const result = await rpcRequest({
    endpoint: getRealtimeRpcEndpoint(env),
    token: env.STELLAR_ARCHIVE_RPC_TOKEN,
    authMode: getRpcAuthMode(env),
    method: "getLatestLedger",
  });

  const sequence = result?.sequence;
  return typeof sequence === "number" ? sequence : parseInt(sequence);
}
