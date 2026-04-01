import type { Env, FailedTransaction, ErrorReadout, ScanResult } from "./types.js";

const SOROBAN_OPERATION_KEYS = new Set([
  "invoke_host_function",
  "restore_footprint",
  "extend_footprint_ttl",
]);

const SUCCESS_KINDS = new Set(["tx_success", "tx_fee_bump_inner_success"]);

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
  const payload = buildLedgersPayload(startLedger, limit, cursor);
  const response = await fetch(env.STELLAR_ARCHIVE_RPC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.STELLAR_ARCHIVE_RPC_TOKEN}`,
    },
    body: payload,
  });

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

function collectInvokeContractCalls(txValue: any): any[] {
  const calls: any[] = [];
  const operations = getLedgerTransactionOperations(txValue);
  for (const op of operations) {
    const invoke = op?.body?.invoke_host_function;
    if (!invoke) continue;
    const invokeContract = invoke?.host_function?.invoke_contract;
    if (!invokeContract) continue;

    const call: Record<string, unknown> = {};
    if (invokeContract.contract_address)
      call.contractId = invokeContract.contract_address;
    if (invokeContract.function_name)
      call.functionName = invokeContract.function_name;
    if (invokeContract.args) {
      call.args = invokeContract.args;
      call.argCount = Array.isArray(invokeContract.args)
        ? invokeContract.args.length
        : 0;
    }
    if (invoke.auth) {
      call.auth = invoke.auth;
      call.authCount = Array.isArray(invoke.auth) ? invoke.auth.length : 0;
    }
    calls.push(call);
  }
  return calls;
}

function collectContractIds(
  invokeCalls: any[],
  diagnosticEvents: unknown[],
  processing: any,
): string[] {
  const ids = new Set<string>();

  // 1. Envelope: top-level invoke_host_function targets
  for (const call of invokeCalls) {
    if (typeof call.contractId === "string") {
      ids.add(call.contractId);
    }
  }

  // 2. Diagnostic events: cross-contract calls, auth contexts, event emitters
  collectContractAddressesFromValue(diagnosticEvents, ids);

  // 3. Processing meta: ledger entry changes (contracts read/written during execution)
  const txApply = processing?.tx_apply_processing?.v4;
  if (txApply) {
    // Operation changes (state reads/writes)
    collectContractAddressesFromValue(txApply.operations, ids);
  }

  return [...ids];
}

/**
 * Recursively walk a JSON value and collect all Stellar contract addresses (C..., 56 chars).
 * Contract IDs appear in: contract_id, contract_address, contract fields,
 * and nested inside address ScVal types.
 */
function collectContractAddressesFromValue(
  obj: unknown,
  ids: Set<string>,
): void {
  if (typeof obj === "string") {
    if (obj.length === 56 && obj.startsWith("C") && /^[A-Z2-7]+$/.test(obj)) {
      ids.add(obj);
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectContractAddressesFromValue(item, ids);
    }
    return;
  }
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      collectContractAddressesFromValue(v, ids);
    }
  }
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
      const txEntry = txEntries[i];
      const processing = txProcessing[i];

      try {
        const txHash = processing?.result?.transaction_hash;
        const resultKind = getProcessingResultKind(processing?.result);
        if (!resultKind || SUCCESS_KINDS.has(resultKind)) continue;
        if (!isSorobanLedgerTransaction(txEntry, processing)) continue;
        if (typeof txHash !== "string" || txHash.length === 0) continue;

        const operationTypes = collectOperationTypes(txEntry);
        const sorobanOperationTypes = collectSorobanOperationTypes(txEntry);
        const invokeCalls = collectInvokeContractCalls(txEntry);

        const rawDiagnosticEvents = getNestedValue(processing, [
          "tx_apply_processing",
          "v4",
          "diagnostic_events",
        ]);
        const diagnosticEvents = Array.isArray(rawDiagnosticEvents)
          ? rawDiagnosticEvents
          : [];

        // Primary contracts: only from the envelope invoke_host_function (for fingerprinting)
        const primaryContractIds: string[] = [];
        for (const call of invokeCalls) {
          if (typeof call.contractId === "string" && !primaryContractIds.includes(call.contractId)) {
            primaryContractIds.push(call.contractId);
          }
        }

        // All contracts: envelope + diag + auth + meta (for context/lookup)
        const contractIds = collectContractIds(invokeCalls, diagnosticEvents, processing);

        const readout = buildErrorReadout(
          txEntry,
          processing,
          resultKind,
          invokeCalls,
          contractIds,
        );

        failed.push({
          txHash,
          ledgerSequence: typeof ledgerSequence === "number" ? ledgerSequence : parseInt(ledgerSequence),
          ledgerCloseTime: String(ledgerCloseTime),
          resultKind,
          soroban: true,
          primaryContractIds,
          contractIds,
          operationTypes,
          sorobanOperationTypes,
          diagnosticEvents,
          envelopeJson: txEntry,
          processingJson: processing,
          readout,
        });
      } catch {
        // Skip malformed transactions
        continue;
      }
    }
  }

  return failed;
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
  // Use the getLatestLedger JSON-RPC method to get the current ledger
  const response = await fetch(env.STELLAR_ARCHIVE_RPC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.STELLAR_ARCHIVE_RPC_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "getLatestLedger",
    }),
  });

  if (!response.ok) {
    throw new Error(`getLatestLedger HTTP ${response.status}`);
  }

  const json: any = await response.json();
  if (json.error) {
    throw new Error(
      `getLatestLedger error: ${json.error.message || JSON.stringify(json.error)}`,
    );
  }

  const sequence = json.result?.sequence;
  return typeof sequence === "number" ? sequence : parseInt(sequence);
}
