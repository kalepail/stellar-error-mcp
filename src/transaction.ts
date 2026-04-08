import { Address, StrKey } from "@stellar/stellar-sdk";
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
const SOROBAN_OPERATION_TYPES = new Set([
  "invoke_host_function",
  "restore_footprint",
  "extend_footprint_ttl",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasMethod<T extends string>(
  value: unknown,
  method: T,
): value is Record<T, (...args: unknown[]) => unknown> {
  return !!value && typeof value === "object" &&
    typeof (value as Record<T, unknown>)[method] === "function";
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

function extractJsonXdrErrorSignature(value: unknown): ErrorSignature | null {
  if (!isRecord(value) || !isRecord(value._switch)) {
    return null;
  }

  const family = value._switch.name;
  if (typeof family !== "string" || !family.startsWith("sce")) {
    return null;
  }

  const rawCode = value._value;
  if (isRecord(rawCode) && typeof rawCode.name === "string") {
    return {
      type: normalizeSdkErrorToken(family),
      code: normalizeSdkErrorToken(rawCode.name),
    };
  }

  if (isRecord(rawCode) && ("value" in rawCode)) {
    return {
      type: normalizeSdkErrorToken(family),
      code: String(rawCode.value).replace(/^#/, ""),
    };
  }

  if (typeof rawCode === "number" || typeof rawCode === "string") {
    return {
      type: normalizeSdkErrorToken(family),
      code: String(rawCode).replace(/^#/, ""),
    };
  }

  return null;
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

function normalizeIdentifier(value: string): string {
  return value
    .replace(/^scv/, "")
    .replace(/^sce/, "")
    .replace(/^hostFunctionType/, "")
    .replace(/^operationType/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function readXdrSwitchName(value: unknown): string | undefined {
  if (!hasMethod(value, "switch")) return undefined;
  const switchValue = value.switch();
  if (switchValue && typeof switchValue === "object" && "name" in switchValue) {
    const name = (switchValue as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function bufferToContractId(value: unknown): string | undefined {
  if (value instanceof Uint8Array && value.length === 32) {
    return StrKey.encodeContract(value);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    const bytes = Uint8Array.from(value);
    if (bytes.length === 32) {
      return StrKey.encodeContract(bytes);
    }
  }
  return undefined;
}

function scAddressToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const contractId = bufferToContractId(value);
  if (contractId) return contractId;

  if (hasMethod(value, "toXDR")) {
    try {
      return Address.fromScAddress(value as never).toString();
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function xdrStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return undefined;
}

function normalizeScErrorCode(value: unknown): string {
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string") return normalizeIdentifier(name);
  }
  return String(value);
}

function extractXdrErrorSignature(value: unknown): ErrorSignature | null {
  if (!hasMethod(value, "switch") || !hasMethod(value, "value")) {
    return null;
  }

  const typeName = readXdrSwitchName(value);
  if (!typeName || !typeName.startsWith("sce")) return null;

  return {
    type: normalizeIdentifier(typeName),
    code: normalizeScErrorCode(value.value()),
  };
}

function collectXdrErrors(value: unknown): ErrorSignature[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectXdrErrors(item));
  }

  const direct = extractXdrErrorSignature(value);
  if (direct) return [direct];

  if (
    hasMethod(value, "switch") &&
    readXdrSwitchName(value) === "scvError" &&
    hasMethod(value, "error")
  ) {
    const fromScVal = extractXdrErrorSignature(value.error());
    return fromScVal ? [fromScVal] : [];
  }

  if (
    hasMethod(value, "switch") &&
    readXdrSwitchName(value) === "scvVec" &&
    hasMethod(value, "vec")
  ) {
    return collectXdrErrors(value.vec() ?? []);
  }

  if (
    hasMethod(value, "switch") &&
    readXdrSwitchName(value) === "scvMap" &&
    hasMethod(value, "map")
  ) {
    return collectXdrErrors(value.map() ?? []);
  }

  return [];
}

function getEnvelopeFromXdrEnvelope(envelope: unknown): unknown | null {
  if (!hasMethod(envelope, "value")) return null;
  return envelope.value();
}

function getTransactionFromEnvelope(envelope: unknown): unknown | null {
  const value = getEnvelopeFromXdrEnvelope(envelope);
  if (!value) return null;

  if (hasMethod(value, "tx")) {
    return value.tx();
  }

  if (hasMethod(value, "innerTx")) {
    const innerTx = value.innerTx();
    if (hasMethod(innerTx, "v1")) {
      const v1 = innerTx.v1();
      if (hasMethod(v1, "tx")) return v1.tx();
    }
  }

  return null;
}

function getInvokeContractArgsFromOperation(operation: unknown): {
  contractId?: string;
  functionName?: string;
  args?: unknown[];
  auth?: unknown[];
} | null {
  if (isRecord(operation)) {
    const invoke = (operation as any)?.body?.invoke_host_function;
    const invokeContract = invoke?.host_function?.invoke_contract;
    if (invokeContract) {
      return {
        contractId:
          typeof invokeContract.contract_address === "string"
            ? invokeContract.contract_address
            : undefined,
        functionName:
          typeof invokeContract.function_name === "string"
            ? invokeContract.function_name
            : undefined,
        args: Array.isArray(invokeContract.args) ? invokeContract.args : undefined,
        auth: Array.isArray(invoke?.auth) ? invoke.auth : undefined,
      };
    }
  }

  if (!hasMethod(operation, "body")) return null;
  const body = operation.body();
  if (
    !hasMethod(body, "switch") ||
    normalizeIdentifier(readXdrSwitchName(body) ?? "") !== "invoke_host_function"
  ) {
    return null;
  }

  const invoke = hasMethod(body, "invokeHostFunctionOp")
    ? body.invokeHostFunctionOp()
    : body.value();
  if (!invoke || !hasMethod(invoke, "hostFunction")) return null;

  const hostFunction = invoke.hostFunction();
  if (
    !hasMethod(hostFunction, "switch") ||
    normalizeIdentifier(readXdrSwitchName(hostFunction) ?? "") !== "invoke_contract"
  ) {
    return null;
  }

  const invokeContract = hasMethod(hostFunction, "invokeContract")
    ? hostFunction.invokeContract()
    : hostFunction.value();
  if (!invokeContract) return null;

  return {
    contractId:
      hasMethod(invokeContract, "contractAddress")
        ? scAddressToString(invokeContract.contractAddress())
        : undefined,
    functionName:
      hasMethod(invokeContract, "functionName")
        ? xdrStringValue(invokeContract.functionName())
        : undefined,
    args: hasMethod(invokeContract, "args") ? invokeContract.args() : undefined,
    auth: hasMethod(invoke, "auth") ? invoke.auth() : undefined,
  };
}

function extractDiagnosticEventContractId(event: unknown): string | undefined {
  if (hasMethod(event, "event")) {
    const inner = event.event();
    if (hasMethod(inner, "contractId")) {
      return bufferToContractId(inner.contractId());
    }
  }

  if (isRecord(event)) {
    const nestedEvent = isRecord(event._attributes)
      ? (event._attributes as Record<string, unknown>).event
      : undefined;
    const nestedAttributes = isRecord(nestedEvent)
      ? (nestedEvent as Record<string, unknown>)._attributes as Record<string, unknown> | undefined
      : undefined;
    const nestedContractId = nestedAttributes?.contractId;
    if (nestedContractId) {
      const decoded = bufferToContractId(nestedContractId);
      if (decoded) return decoded;
    }
    if (typeof event.contract_id === "string") return event.contract_id;
    if (typeof event.contractId === "string") return event.contractId;
  }

  return undefined;
}

function extractDiagnosticEventPayload(event: unknown): {
  contractId?: string;
  topics: unknown[];
  data: unknown;
} | null {
  if (hasMethod(event, "event")) {
    const inner = event.event();
    if (!hasMethod(inner, "body")) return null;
    const body = inner.body();
    const v0 = hasMethod(body, "v0")
      ? body.v0()
      : hasMethod(body, "value")
      ? body.value()
      : null;
    const topics = v0 && hasMethod(v0, "topics") ? v0.topics() : [];
    const data = v0 && hasMethod(v0, "data") ? v0.data() : undefined;
    return {
      contractId: extractDiagnosticEventContractId(event),
      topics: Array.isArray(topics) ? topics : [],
      data,
    };
  }

  if (isRecord(event)) {
    const evt = event as Record<string, unknown>;
    const body = evt.body as Record<string, unknown> | undefined;
    const nestedEvent = isRecord(evt._attributes)
      ? (evt._attributes as Record<string, unknown>).event
      : undefined;
    const nestedAttributes = isRecord(nestedEvent)
      ? (nestedEvent as Record<string, unknown>)._attributes as Record<string, unknown> | undefined
      : undefined;
    const nestedBody = nestedAttributes?.body as Record<string, unknown> | undefined;
    const nestedValue = nestedBody?._value as Record<string, unknown> | undefined;
    const nestedV0 = nestedValue?._attributes as Record<string, unknown> | undefined;
    const v0 = body?.v0 as Record<string, unknown> | undefined;
    const topics = (v0?.topics ?? body?.topics ?? nestedV0?.topics) as unknown[] ?? [];
    const data = v0?.data ?? body?.data ?? nestedV0?.data;
    return {
      contractId: extractDiagnosticEventContractId(event),
      topics,
      data,
    };
  }

  return null;
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
  const transaction = getTransactionFromEnvelope(value);
  if (transaction && hasMethod(transaction, "operations")) {
    return transaction
      .operations()
      .flatMap((operation: unknown) => {
        const invoke = getInvokeContractArgsFromOperation(operation);
        return invoke?.functionName ? [invoke.functionName] : [];
      });
  }

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
  const xdrSignatures = diagnosticEvents.flatMap((event) => {
    const payload = extractDiagnosticEventPayload(event);
    if (!payload) return collectXdrErrors(event);
    return [...collectXdrErrors(payload.topics), ...collectXdrErrors(payload.data)];
  });

  const seen = new Set<string>();
  const signatures: ErrorSignature[] = [];

  for (const signature of xdrSignatures) {
    const key = `${signature.type}:${signature.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    signatures.push(signature);
  }

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

    const jsonXdrSignature = extractJsonXdrErrorSignature(value);
    if (jsonXdrSignature) {
      const key = `${jsonXdrSignature.type}:${jsonXdrSignature.code}`;
      if (!seen.has(key)) {
        seen.add(key);
        signatures.push(jsonXdrSignature);
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
  if (hasMethod(operation, "body")) {
    const body = operation.body();
    const switchName = readXdrSwitchName(body);
    if (switchName) return normalizeIdentifier(switchName);
  }

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
  const transaction = getTransactionFromEnvelope(envelope);
  if (transaction && hasMethod(transaction, "operations")) {
    return transaction.operations();
  }

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
    const call = getInvokeContractArgsFromOperation(operation) ??
      extractFlattenedInvokeCall(operation) ??
      extractSdkInvokeCall(operation);
    if (call) calls.push(call);
  }

  return calls;
}

export function extractAuthEntries(envelope: unknown): unknown[] {
  const invokeAuth = extractInvokeCalls(envelope)
    .flatMap((call) => Array.isArray(call.auth) ? call.auth : []);
  if (invokeAuth.length > 0) {
    return invokeAuth;
  }

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
  const invokeCalls = extractInvokeCalls(envelope);
  const errorSignatures = extractErrorSignatures(diagnosticEvents);
  const touchedContractIds = new Set<string>();

  for (const call of invokeCalls) {
    if (typeof call.contractId === "string" && call.contractId.length > 0) {
      touchedContractIds.add(call.contractId);
    }
  }
  for (const event of diagnosticEvents) {
    const contractId = extractDiagnosticEventContractId(event);
    if (contractId) touchedContractIds.add(contractId);
  }
  for (const contractId of collectContractIdsFromValue(envelope)) {
    touchedContractIds.add(contractId);
  }
  for (const contractId of collectContractIdsFromValue(processing)) {
    touchedContractIds.add(contractId);
  }

  return {
    topLevelFunction: extractFunctionName(envelope),
    errorSignatures,
    invokeCalls,
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
