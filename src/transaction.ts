import type {
  DecodedTransactionContext,
  ErrorSignature,
  TransactionInvokeCall,
  TransactionLedgerChange,
  TransactionOperationContext,
  TransactionResourceLimits,
} from "./types.js";
import { deepDecodeXdr } from "./xdr.js";

const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

export function walkJson(
  obj: unknown,
  callback: (key: string, value: unknown, parent: unknown) => void,
): void {
  if (Array.isArray(obj)) {
    for (const item of obj) walkJson(item, callback);
    return;
  }

  if (!obj || typeof obj !== "object") return;

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    callback(key, value, obj);
    walkJson(value, callback);
  }
}

export function collectContractIdsFromValue(obj: unknown): string[] {
  const ids = new Set<string>();
  walkJson(obj, (_key, value) => {
    if (typeof value === "string" && CONTRACT_ID_PATTERN.test(value)) {
      ids.add(value);
    }
  });
  return [...ids];
}

function collectErrors(value: unknown): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  if (Array.isArray(value)) {
    for (const item of value) results.push(...collectErrors(item));
    return results;
  }

  if (!value || typeof value !== "object") return results;

  const obj = value as Record<string, unknown>;
  if ("error" in obj && obj.error !== null && obj.error !== undefined) {
    results.push(obj.error as Record<string, unknown>);
  }

  for (const inner of Object.values(obj)) {
    results.push(...collectErrors(inner));
  }

  return results;
}

function collectFunctionNames(value: unknown): string[] {
  const results: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) results.push(...collectFunctionNames(item));
    return results;
  }

  if (!value || typeof value !== "object") return results;

  const obj = value as Record<string, unknown>;
  if ("function_name" in obj && typeof obj.function_name === "string") {
    results.push(obj.function_name);
  }

  for (const inner of Object.values(obj)) {
    results.push(...collectFunctionNames(inner));
  }

  return results;
}

export function extractErrorSignatures(
  diagnosticEvents: unknown[],
): ErrorSignature[] {
  const errors = collectErrors(diagnosticEvents);
  const seen = new Set<string>();
  const signatures: ErrorSignature[] = [];

  for (const err of errors) {
    for (const [type, code] of Object.entries(err)) {
      const signature = { type, code: String(code) };
      const key = `${signature.type}:${signature.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signatures.push(signature);
    }
  }

  return signatures.sort((a, b) =>
    `${a.type}:${a.code}`.localeCompare(`${b.type}:${b.code}`),
  );
}

export function extractFunctionName(envelopeJson: unknown): string {
  return collectFunctionNames(envelopeJson)[0] ?? "unknown";
}

export function extractEnvelopeOperations(envelope: unknown): unknown[] {
  if ((envelope as any)?.tx?.tx?.operations) {
    return (envelope as any).tx.tx.operations;
  }
  if ((envelope as any)?.tx_fee_bump?.tx?.inner_tx?.tx?.tx?.operations) {
    return (envelope as any).tx_fee_bump.tx.inner_tx.tx.tx.operations;
  }
  return [];
}

export function extractProcessingOperations(processing: unknown): unknown[] {
  const operations = (processing as any)?.tx_apply_processing?.v4?.operations;
  return Array.isArray(operations) ? operations : [];
}

export function extractInvokeCalls(envelope: unknown): TransactionInvokeCall[] {
  const calls: TransactionInvokeCall[] = [];

  for (const operation of extractEnvelopeOperations(envelope)) {
    const invoke = (operation as any)?.body?.invoke_host_function;
    const invokeContract = invoke?.host_function?.invoke_contract;
    if (!invokeContract) continue;

    calls.push({
      contractId: invokeContract.contract_address,
      functionName: invokeContract.function_name,
      args: invokeContract.args,
      argCount: Array.isArray(invokeContract.args)
        ? invokeContract.args.length
        : 0,
      auth: invoke?.auth,
      authCount: Array.isArray(invoke?.auth) ? invoke.auth.length : 0,
    });
  }

  return calls;
}

export function extractAuthEntries(envelope: unknown): unknown[] {
  const entries: unknown[] = [];

  walkJson(envelope, (key, value) => {
    if (key === "auth" && Array.isArray(value)) {
      entries.push(...value);
      return;
    }
    if (key === "soroban_credentials" && value && typeof value === "object") {
      entries.push(value);
    }
  });

  return entries;
}

export function extractResourceLimits(
  envelope: unknown,
): TransactionResourceLimits | null {
  let resources: TransactionResourceLimits | null = null;

  walkJson(envelope, (key, value) => {
    if (key !== "resources" || !value || typeof value !== "object") return;

    const resourceObj = value as Record<string, unknown>;
    if (!("instructions" in resourceObj) && !("read_bytes" in resourceObj)) {
      return;
    }

    resources = {
      instructions:
        typeof resourceObj.instructions === "number"
          ? resourceObj.instructions
          : undefined,
      readBytes:
        typeof resourceObj.read_bytes === "number"
          ? resourceObj.read_bytes
          : undefined,
      writeBytes:
        typeof resourceObj.write_bytes === "number"
          ? resourceObj.write_bytes
          : undefined,
      extendedMetaDataSizeBytes:
        typeof resourceObj.extended_meta_data_size_bytes === "number"
          ? resourceObj.extended_meta_data_size_bytes
          : undefined,
    };
  });

  return resources;
}

export function extractResultDetails(processing: unknown): unknown {
  if (!processing || typeof processing !== "object") return null;
  return (processing as Record<string, unknown>).result ?? null;
}

export function extractSorobanMeta(processing: unknown): unknown {
  return (processing as any)?.tx_apply_processing?.v4?.soroban_meta ?? null;
}

export function extractContractEvents(processing: unknown): unknown[] {
  const events = (processing as any)?.tx_apply_processing?.v4?.events;
  return Array.isArray(events) ? events : [];
}

export function extractDiagnosticEvents(processing: unknown): unknown[] {
  const events = (processing as any)?.tx_apply_processing?.v4?.diagnostic_events;
  return Array.isArray(events) ? events : [];
}

function findPrimaryObjectKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 ? keys[0] : undefined;
}

function findLedgerEntryType(value: unknown): string | undefined {
  let ledgerEntryType: string | undefined;

  walkJson(value, (key, inner) => {
    if (ledgerEntryType) return;

    if (
      key === "contract_data" ||
      key === "contract_code" ||
      key === "account" ||
      key === "trustline" ||
      key === "data" ||
      key === "claimable_balance" ||
      key === "offer" ||
      key === "liquidity_pool" ||
      key === "ttl"
    ) {
      ledgerEntryType = key;
      return;
    }

    if (
      key === "type" &&
      typeof inner === "string" &&
      inner.startsWith("ledgerEntry")
    ) {
      ledgerEntryType = inner;
    }
  });

  return ledgerEntryType;
}

function normalizeOperationType(operation: unknown): string | undefined {
  const body = (operation as any)?.body;
  if (!body || typeof body !== "object") return undefined;
  const keys = Object.keys(body);
  return keys.length > 0 ? keys[0] : undefined;
}

function buildOperationContexts(
  envelope: unknown,
  processing: unknown,
): TransactionOperationContext[] {
  const envelopeOperations = extractEnvelopeOperations(envelope);
  const processingOperations = extractProcessingOperations(processing);
  const maxLength = Math.max(envelopeOperations.length, processingOperations.length);
  const contexts: TransactionOperationContext[] = [];

  for (let index = 0; index < maxLength; index++) {
    const envelopeOperation = envelopeOperations[index] ?? null;
    const processingOperation = processingOperations[index] ?? null;
    const changes = Array.isArray((processingOperation as any)?.changes)
      ? (processingOperation as any).changes
      : [];
    const events = Array.isArray((processingOperation as any)?.events)
      ? (processingOperation as any).events
      : [];
    const diagnosticEvents = Array.isArray(
      (processingOperation as any)?.diagnostic_events,
    )
      ? (processingOperation as any).diagnostic_events
      : [];

    contexts.push({
      index,
      operationType: normalizeOperationType(envelopeOperation),
      sourceAccount:
        typeof (envelopeOperation as any)?.source_account === "string"
          ? (envelopeOperation as any).source_account
          : undefined,
      envelopeOperation,
      processing: processingOperation,
      changeCount: changes.length,
      eventCount: events.length,
      diagnosticEventCount: diagnosticEvents.length,
      touchedContractIds: collectContractIdsFromValue({
        envelopeOperation,
        processingOperation,
      }),
      changes,
      events,
      diagnosticEvents,
    });
  }

  return contexts;
}

function buildLedgerChanges(
  operationContexts: TransactionOperationContext[],
): TransactionLedgerChange[] {
  return operationContexts.flatMap((operation) =>
    operation.changes.map((change) => ({
      operationIndex: operation.index,
      changeType: findPrimaryObjectKey(change),
      ledgerEntryType: findLedgerEntryType(change),
      contractIds: collectContractIdsFromValue(change),
      change,
    })),
  );
}

export function buildDecodedTransactionContext(
  envelope: unknown,
  processing: unknown,
): DecodedTransactionContext {
  const diagnosticEvents = extractDiagnosticEvents(processing);
  const operationContexts = buildOperationContexts(envelope, processing);
  const touchedContractIds = new Set<string>();

  for (const contractId of collectContractIdsFromValue(envelope)) {
    touchedContractIds.add(contractId);
  }
  for (const contractId of collectContractIdsFromValue(processing)) {
    touchedContractIds.add(contractId);
  }

  return {
    topLevelFunction: extractFunctionName(envelope),
    errorSignatures: extractErrorSignatures(diagnosticEvents),
    invokeCalls: extractInvokeCalls(envelope),
    authEntries: extractAuthEntries(envelope),
    resourceLimits: extractResourceLimits(envelope),
    transactionResult: extractResultDetails(processing),
    sorobanMeta: extractSorobanMeta(processing),
    contractEvents: extractContractEvents(processing),
    diagnosticEvents,
    envelopeOperations: extractEnvelopeOperations(envelope),
    processingOperations: operationContexts,
    ledgerChanges: buildLedgerChanges(operationContexts),
    touchedContractIds: [...touchedContractIds],
  };
}

export function attachDeepDecodedViews(
  decoded: DecodedTransactionContext,
  envelope: unknown,
  processing: unknown,
): DecodedTransactionContext {
  return {
    ...decoded,
    decodedEnvelope: deepDecodeXdr(envelope, 4),
    decodedProcessing: deepDecodeXdr(processing, 4),
  };
}
