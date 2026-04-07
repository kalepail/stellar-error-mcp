import type {
  DecodedTransactionContext,
  ErrorSignature,
  TransactionInvokeCall,
  TransactionLedgerChange,
  TransactionOperationContext,
  TransactionResourceLimits,
} from "./types.js";
import { StrKey } from "@stellar/stellar-sdk";
import { deepDecodeXdr } from "./xdr.js";

const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;
const SOROBAN_OPERATION_TYPES = new Set([
  "invoke_host_function",
  "restore_footprint",
  "extend_footprint_ttl",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toSnakeCase(value: string): string {
  return value
    .replace(/Op$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/__+/g, "_")
    .toLowerCase();
}

function decodeBufferLike(value: unknown): Buffer | null {
  if (!isRecord(value)) return null;
  if (value.type !== "Buffer" || !Array.isArray(value.data)) return null;

  const bytes = value.data.filter((item): item is number =>
    typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255
  );
  return bytes.length === value.data.length ? Buffer.from(bytes) : null;
}

function decodeUtf8Buffer(value: unknown): string | null {
  const buffer = decodeBufferLike(value);
  if (!buffer) return null;
  return buffer.toString("utf8").replace(/\0+$/g, "");
}

function decodeFunctionNameValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return decodeUtf8Buffer(value);
}

function decodeContractIdValue(value: unknown): string | null {
  if (typeof value === "string" && CONTRACT_ID_PATTERN.test(value)) {
    return value;
  }

  if (!isRecord(value)) return null;

  if (
    isRecord(value._switch) &&
    typeof value._switch.name === "string" &&
    value._switch.name === "scAddressTypeContract"
  ) {
    const buffer = decodeBufferLike(value._value);
    return buffer ? StrKey.encodeContract(buffer) : null;
  }

  if (typeof value._arm === "string" && value._arm === "contractId") {
    const buffer = decodeBufferLike(value._value);
    return buffer ? StrKey.encodeContract(buffer) : null;
  }

  return null;
}

function normalizeSdkErrorToken(value: string): string {
  const trimmed = value.replace(/^scec?/, "");
  return toSnakeCase(trimmed).replace(/^_+|_+$/g, "");
}

function parseErrorLiteral(value: string): ErrorSignature | null {
  const trimmed = value.trim();
  const match = /^Error\(([^,]+),\s*([^)]+)\)$/.exec(trimmed);
  if (!match) return null;

  const family = normalizeSdkErrorToken(match[1] ?? "");
  const codeRaw = (match[2] ?? "").trim();
  if (!family || !codeRaw) return null;

  const contractCode = /^#?\d+$/.exec(codeRaw);
  if (contractCode) {
    return {
      type: family,
      code: codeRaw.replace(/^#/, ""),
    };
  }

  return {
    type: family,
    code: normalizeSdkErrorToken(codeRaw),
  };
}

function extractSdkErrorSignature(value: unknown): ErrorSignature | null {
  if (!isRecord(value) || !isRecord(value._switch) || !isRecord(value._value)) {
    return null;
  }

  const family = value._switch.name;
  const code = value._value.name;
  if (
    typeof family !== "string" ||
    typeof code !== "string" ||
    !family.startsWith("sce") ||
    !code.startsWith("scec")
  ) {
    return null;
  }

  return {
    type: normalizeSdkErrorToken(family),
    code: normalizeSdkErrorToken(code),
  };
}

function getRecordPath(
  value: unknown,
  path: string[],
): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

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
    const contractId = decodeContractIdValue(value);
    if (contractId) {
      ids.add(contractId);
    }
  });
  return [...ids];
}

function collectFunctionNames(value: unknown): string[] {
  const results: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) results.push(...collectFunctionNames(item));
    return results;
  }

  if (!isRecord(value)) return results;

  const obj = value;
  if ("function_name" in obj && typeof obj.function_name === "string") {
    results.push(obj.function_name);
  }
  if ("functionName" in obj) {
    const decoded = decodeFunctionNameValue(obj.functionName);
    if (decoded) results.push(decoded);
  }
  if ("fn_name" in obj && typeof obj.fn_name === "string") {
    results.push(obj.fn_name);
  }

  for (const inner of Object.values(obj)) {
    results.push(...collectFunctionNames(inner));
  }

  return results;
}

export function extractErrorSignatures(
  diagnosticEvents: unknown[],
): ErrorSignature[] {
  const seen = new Set<string>();
  const signatures: ErrorSignature[] = [];

  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const parsed = parseErrorLiteral(value);
      if (parsed) {
        const key = `${parsed.type}:${parsed.code}`;
        if (!seen.has(key)) {
          seen.add(key);
          signatures.push(parsed);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (!isRecord(value)) return;

    if ("error" in value && isRecord(value.error)) {
      for (const [type, code] of Object.entries(value.error)) {
        const signature = { type, code: String(code) };
        const key = `${signature.type}:${signature.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        signatures.push(signature);
      }
    }

    const sdkSignature = extractSdkErrorSignature(value);
    if (sdkSignature) {
      const key = `${sdkSignature.type}:${sdkSignature.code}`;
      if (!seen.has(key)) {
        seen.add(key);
        signatures.push(sdkSignature);
      }
    }

    for (const inner of Object.values(value)) {
      visit(inner);
    }
  };

  visit(diagnosticEvents);

  return signatures.sort((a, b) =>
    `${a.type}:${a.code}`.localeCompare(`${b.type}:${b.code}`),
  );
}

export function extractOperationType(operation: unknown): string | undefined {
  const body = (operation as any)?.body ?? (operation as any)?._attributes?.body;
  if (!isRecord(body)) return undefined;

  if (!("_switch" in body) || !isRecord(body._switch)) {
    const keys = Object.keys(body);
    return keys.length > 0 ? keys[0] : undefined;
  }

  if (typeof body._switch.name !== "string") return undefined;
  return toSnakeCase(body._switch.name);
}

export function extractOperationTypes(envelope: unknown): string[] {
  const types = new Set<string>();
  for (const operation of extractEnvelopeOperations(envelope)) {
    const type = extractOperationType(operation);
    if (type) types.add(type);
  }
  return [...types];
}

export function extractSorobanOperationTypes(envelope: unknown): string[] {
  return extractOperationTypes(envelope).filter((type) =>
    SOROBAN_OPERATION_TYPES.has(type)
  );
}

function extractSdkInvokeCall(operation: unknown): TransactionInvokeCall | null {
  const body = (operation as any)?._attributes?.body;
  if (!isRecord(body) || body._arm !== "invokeHostFunctionOp") {
    return null;
  }

  const invoke = getRecordPath(body, ["_value", "_attributes"]);
  const hostFunction = getRecordPath(invoke, ["hostFunction"]);
  if (!isRecord(hostFunction) || hostFunction._arm !== "invokeContract") {
    return null;
  }

  const invokeContract = getRecordPath(hostFunction, ["_value", "_attributes"]);
  if (!isRecord(invokeContract)) return null;

  const auth = Array.isArray((invoke as any)?.auth) ? (invoke as any).auth : undefined;
  const contractId = decodeContractIdValue(invokeContract.contractAddress);
  const functionName = decodeFunctionNameValue(invokeContract.functionName);
  const args = Array.isArray(invokeContract.args) ? invokeContract.args : undefined;

  return {
    contractId: contractId ?? invokeContract.contractAddress,
    functionName: functionName ?? invokeContract.functionName,
    args,
    argCount: args?.length ?? 0,
    auth,
    authCount: auth?.length ?? 0,
  };
}

function extractFlattenedInvokeCall(operation: unknown): TransactionInvokeCall | null {
  const invoke = (operation as any)?.body?.invoke_host_function;
  const invokeContract = invoke?.host_function?.invoke_contract;
  if (!invokeContract) return null;

  return {
    contractId: invokeContract.contract_address,
    functionName: invokeContract.function_name,
    args: invokeContract.args,
    argCount: Array.isArray(invokeContract.args)
      ? invokeContract.args.length
      : 0,
    auth: invoke?.auth,
    authCount: Array.isArray(invoke?.auth) ? invoke.auth.length : 0,
  };
}

export function extractFunctionName(envelopeJson: unknown): string {
  return collectFunctionNames(envelopeJson)[0] ?? "unknown";
}

export function extractEnvelopeOperations(envelope: unknown): unknown[] {
  const candidates = [
    getRecordPath(envelope, ["tx", "tx", "operations"]),
    getRecordPath(envelope, ["tx_fee_bump", "tx", "inner_tx", "tx", "tx", "operations"]),
    getRecordPath(envelope, ["_value", "_attributes", "tx", "_attributes", "operations"]),
    getRecordPath(
      envelope,
      ["_value", "_attributes", "tx", "_attributes", "innerTx", "_attributes", "tx", "_attributes", "operations"],
    ),
    getRecordPath(
      envelope,
      ["_value", "_attributes", "tx", "_attributes", "innerTx", "_attributes", "operations"],
    ),
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

export function extractInvokeCalls(envelope: unknown): TransactionInvokeCall[] {
  const calls: TransactionInvokeCall[] = [];

  for (const operation of extractEnvelopeOperations(envelope)) {
    const call = extractFlattenedInvokeCall(operation) ?? extractSdkInvokeCall(operation);
    if (call) calls.push(call);
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
export function extractProcessingOperations(processing: unknown): unknown[] {
  const operations = (processing as any)?.tx_apply_processing?.v4?.operations;
  return Array.isArray(operations) ? operations : [];
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
      operationType: extractOperationType(envelopeOperation),
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
