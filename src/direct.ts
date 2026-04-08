import { xdr } from "@stellar/stellar-sdk";
import {
  buildDecodedTransactionContext,
  collectContractIdsFromValue,
  extractOperationTypes,
} from "./transaction.js";
import { normalizeXdrBase64 } from "./input.js";
import type {
  DirectErrorSubmission,
  ErrorReadout,
  ErrorSignature,
  FailedTransaction,
  TransactionRpcContext,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96) || "unknown";
}

function pruneUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, inner]) => inner !== undefined),
  );
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    if (/^\d+$/.test(value.trim())) {
      return new Date(Number(value.trim()) * 1000).toISOString();
    }
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallback;
}

function xdrToJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

async function decodePreferredXdr(
  xdrBase64: string,
  knownType: string,
  fallback: () => unknown,
): Promise<unknown> {
  try {
    const { decodeXdrWithType } = await import("./xdr.js");
    const decoded = decodeXdrWithType(xdrBase64, knownType);
    if (decoded?.json) return decoded.json;
  } catch {
    // Fall back to SDK JSON when the richer decoder is unavailable.
  }
  return fallback();
}

async function parseEnvelopeXdr(xdrBase64: string): Promise<unknown> {
  return await decodePreferredXdr(
    normalizeXdrBase64(xdrBase64),
    "TransactionEnvelope",
    () =>
      xdrToJson(
        xdr.TransactionEnvelope.fromXDR(normalizeXdrBase64(xdrBase64), "base64"),
      ),
  );
}

async function parseResultXdr(xdrBase64: string): Promise<unknown> {
  return await decodePreferredXdr(
    normalizeXdrBase64(xdrBase64),
    "TransactionResult",
    () =>
      xdrToJson(
        xdr.TransactionResult.fromXDR(normalizeXdrBase64(xdrBase64), "base64"),
      ),
  );
}

async function parseResultMetaXdr(xdrBase64: string): Promise<unknown> {
  return await decodePreferredXdr(
    normalizeXdrBase64(xdrBase64),
    "TransactionMeta",
    () =>
      xdrToJson(
        xdr.TransactionMeta.fromXDR(normalizeXdrBase64(xdrBase64), "base64"),
      ),
  );
}

function normalizeTxResultKind(value: string): string {
  return normalizeCode(
    value.replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
  );
}

function extractTxResultSwitchName(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractTxResultSwitchName(item);
      if (found) return found;
    }
    return null;
  }

  if (!isRecord(value)) return null;

  const maybeSwitch = value._switch;
  if (isRecord(maybeSwitch) && typeof maybeSwitch.name === "string") {
    if (/^tx(?:_|[A-Z])/.test(maybeSwitch.name)) {
      return maybeSwitch.name;
    }
  }

  for (const inner of Object.values(value)) {
    const found = extractTxResultSwitchName(inner);
    if (found) return found;
  }

  return null;
}

function extractRpcSendResultKind(resultJson: unknown): string | null {
  if (
    resultJson &&
    typeof resultJson === "object" &&
    typeof (resultJson as { result?: () => { switch?: () => { name?: string } } }).result === "function"
  ) {
    const switchName = (resultJson as {
      result: () => { switch?: () => { name?: string } };
    }).result()?.switch?.()?.name;
    if (typeof switchName === "string" && switchName.length > 0) {
      return normalizeTxResultKind(switchName);
    }
  }

  const directKey = findMatchingKey(
    resultJson,
    (key) => /^tx(?:_|[A-Z])/.test(key),
  );
  if (directKey) {
    return normalizeTxResultKind(directKey);
  }

  const switchName = extractTxResultSwitchName(resultJson);
  return switchName ? normalizeTxResultKind(switchName) : null;
}

async function parseDiagnosticEvents(events: unknown): Promise<unknown[]> {
  if (!Array.isArray(events)) return [];
  const parsed: unknown[] = [];

  for (const [index, item] of events.entries()) {
    if (typeof item === "string" && item.length > 0) {
      try {
        parsed.push(
          xdrToJson(
            xdr.DiagnosticEvent.fromXDR(normalizeXdrBase64(item), "base64"),
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid diagnostic event at index ${index}: ${message}`);
      }
      continue;
    }

    if (isRecord(item)) {
      parsed.push(item);
      continue;
    }

    throw new Error(
      `Invalid diagnostic event at index ${index}: expected base64 XDR string or object.`,
    );
  }

  return parsed;
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
    if (!Array.isArray(v4.diagnostic_events)) v4.diagnostic_events = diagnosticEvents;
    if (!Array.isArray(v4.events)) v4.events = [];
    if (!Array.isArray(v4.operations)) v4.operations = [];
    if (!("soroban_meta" in v4)) v4.soroban_meta = null;
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

function hasMethod<T extends string>(
  value: unknown,
  method: T,
): value is Record<T, (...args: unknown[]) => unknown> {
  return !!value && typeof value === "object" &&
    typeof (value as Record<T, unknown>)[method] === "function";
}

function extractScValString(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;

  if (isRecord(value)) {
    const arm = value._arm;
    const raw = value._value;
    if ((arm === "str" || arm === "sym") && isRecord(raw) && Array.isArray(raw.data)) {
      return Buffer.from(raw.data).toString("utf8");
    }
  }

  if (!hasMethod(value, "switch")) return undefined;
  const switchName = (value.switch() as { name?: unknown } | undefined)?.name;
  if (switchName !== "scvString" && switchName !== "scvSymbol") return undefined;

  if (hasMethod(value, "str")) {
    const raw = value.str();
    if (raw instanceof Uint8Array) return Buffer.from(raw).toString("utf8");
    if (typeof raw === "string") return raw;
  }

  if (hasMethod(value, "sym")) {
    const raw = value.sym();
    if (raw instanceof Uint8Array) return Buffer.from(raw).toString("utf8");
    if (typeof raw === "string") return raw;
  }

  return undefined;
}

function extractDiagnosticEventDataStrings(event: unknown): string[] {
  const values: unknown[] = [];

  if (hasMethod(event, "event")) {
    const inner = event.event();
    if (hasMethod(inner, "body")) {
      const body = inner.body();
      const v0 = hasMethod(body, "v0")
        ? body.v0()
        : hasMethod(body, "value")
        ? body.value()
        : null;
      if (v0 && hasMethod(v0, "data")) {
        const data = v0.data();
        if (hasMethod(data, "vec")) {
          const vec = data.vec();
          if (Array.isArray(vec)) values.push(...vec);
        } else if (Array.isArray(data)) {
          values.push(...data);
        } else if (data !== undefined) {
          values.push(data);
        }
      }
    }
  } else if (isRecord(event)) {
    const body = event.body as Record<string, unknown> | undefined;
    const bodyAttributes = isRecord(event._attributes)
      ? ((event._attributes as Record<string, unknown>).event as Record<string, unknown> | undefined)
          ?._attributes as Record<string, unknown> | undefined
      : undefined;
    const nestedBody = bodyAttributes?.body as Record<string, unknown> | undefined;
    const nestedValue = nestedBody?._value as Record<string, unknown> | undefined;
    const nestedAttributes = nestedValue?._attributes as Record<string, unknown> | undefined;
    const v0 = body?.v0 as Record<string, unknown> | undefined;
    const data = v0?.data ?? body?.data ?? nestedAttributes?.data;
    if (Array.isArray(data)) {
      values.push(...data);
    } else if (isRecord(data) && Array.isArray(data._value)) {
      values.push(...data._value);
    } else if (data !== undefined) {
      values.push(data);
    }
  }

  return values
    .map((value) => extractScValString(value))
    .filter((value): value is string => !!value && value.trim().length > 0);
}

function synthesizeSimulationError(diagnosticEvents: unknown[]): string | undefined {
  for (const event of diagnosticEvents) {
    const values = extractDiagnosticEventDataStrings(event);
    if (values.length > 0) return values[0];
  }
  return undefined;
}

function summarizeSimulationError(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "unknown";

  const firstParagraph = trimmed.split(/\n\s*\n/, 1)[0] ?? trimmed;
  const firstLine = firstParagraph.split("\n", 1)[0] ?? firstParagraph;
  return firstLine.trim() || trimmed;
}

function findMatchingKey(
  value: unknown,
  predicate: (key: string) => boolean,
): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMatchingKey(item, predicate);
      if (found) return found;
    }
    return null;
  }

  if (!isRecord(value)) return null;

  for (const [key, inner] of Object.entries(value)) {
    if (predicate(key)) return key;
    const found = findMatchingKey(inner, predicate);
    if (found) return found;
  }

  return null;
}

function collectOperationTypes(envelopeJson: unknown): string[] {
  return extractOperationTypes(envelopeJson);
}

function fallbackErrorSignatures(
  resultKind: string,
  simulationError?: string,
): ErrorSignature[] {
  const signatures: ErrorSignature[] = [];
  if (resultKind) {
    signatures.push({ type: "result", code: resultKind });
  }
  if (simulationError) {
    signatures.push({
      type: "simulation",
      code: normalizeCode(simulationError),
    });
  }
  return signatures;
}

function extractSimulationErrorHeadline(value: string): string {
  return value.split(/\n\s*\n|\n/)[0]?.trim() || value.trim();
}

async function createSyntheticHash(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function buildReadout(
  observationKind: FailedTransaction["observationKind"],
  resultKind: string,
  decoded: FailedTransaction["decoded"],
  contractIds: string[],
  envelopeJson: unknown,
  response: Record<string, unknown>,
  sourceReference: string,
  simulationErrorOverride?: string,
): ErrorReadout {
  const serializedEnvelope = JSON.stringify(envelopeJson);
  const latestLedgerCloseTime = typeof response.latestLedgerCloseTime === "number"
    ? response.latestLedgerCloseTime
    : typeof response.latestLedgerCloseTime === "string" &&
        /^\d+$/.test(response.latestLedgerCloseTime.trim())
    ? Number(response.latestLedgerCloseTime.trim())
    : undefined;

  return {
    observationKind,
    resultKind,
    feeBump: serializedEnvelope.includes("tx_fee_bump"),
    invokeCallCount: decoded.invokeCalls.length,
    contractCount: contractIds.length,
    hasSorobanMeta: decoded.sorobanMeta !== null && decoded.sorobanMeta !== undefined,
    hasEvents: decoded.contractEvents.length > 0,
    hasDiagnosticEvents: decoded.diagnosticEvents.length > 0,
    eventCount: decoded.contractEvents.length || undefined,
    diagnosticEventCount: decoded.diagnosticEvents.length || undefined,
    latestLedger:
      typeof response.latestLedger === "number" ? response.latestLedger : undefined,
    latestLedgerCloseTime,
    rpcStatus: typeof response.status === "string" ? response.status : undefined,
    simulationError: simulationErrorOverride ??
      (typeof response.error === "string" ? response.error : undefined),
    sourceReference,
  };
}

function buildProcessingJson(
  resultKind: string,
  diagnosticEvents: unknown[],
  result: Record<string, unknown>,
  transactionHash?: string,
): unknown {
  return {
    result: {
      transaction_hash: transactionHash,
      result: {
        [resultKind]: {
          ...pruneUndefined(result),
        },
      },
    },
    tx_apply_processing: {
      v4: {
        operations: [],
        events: [],
        diagnostic_events: diagnosticEvents,
        soroban_meta: null,
      },
    },
  };
}

function buildSourcePayload(
  submission: DirectErrorSubmission,
  observedAt: string,
): Record<string, unknown> | undefined {
  if (!submission.sourceLabel && !submission.submittedAt) {
    return undefined;
  }

  return pruneUndefined({
    submittedAt: observedAt,
    sourceLabel: submission.sourceLabel,
  });
}

function parseRpcContext(
  value: Record<string, unknown>,
): TransactionRpcContext | undefined {
  const network = value.network;
  const rpcContext: TransactionRpcContext = {
    network:
      network === "mainnet" ||
        network === "testnet" ||
        network === "futurenet" ||
        network === "custom"
        ? network
        : undefined,
    rpcEndpoint: typeof value.rpcEndpoint === "string" ? value.rpcEndpoint : undefined,
    archiveRpcEndpoint:
      typeof value.archiveRpcEndpoint === "string" ? value.archiveRpcEndpoint : undefined,
    authMode:
      value.rpcAuthMode === "header" || value.rpcAuthMode === "path"
        ? value.rpcAuthMode
        : undefined,
  };

  return rpcContext.network || rpcContext.rpcEndpoint || rpcContext.archiveRpcEndpoint ||
      rpcContext.authMode
    ? rpcContext
    : undefined;
}

export function parseDirectErrorSubmission(
  raw: unknown,
): DirectErrorSubmission {
  if (!isRecord(raw)) {
    throw new Error("Request body must be a JSON object.");
  }

  const kind = raw.kind;
  const transactionXdr = typeof raw.transactionXdr === "string"
    ? raw.transactionXdr
    : null;
  const response = isRecord(raw.response)
    ? raw.response
    : null;

  if (kind !== "rpc_send" && kind !== "rpc_simulate") {
    throw new Error("kind must be either 'rpc_send' or 'rpc_simulate'.");
  }
  if (!transactionXdr) {
    throw new Error("transactionXdr is required for direct error ingestion.");
  }
  if (!response) {
    throw new Error("response is required and must be an object.");
  }

  return {
    kind,
    transactionXdr,
    response,
    submittedAt: typeof raw.submittedAt === "string"
      ? raw.submittedAt
      : undefined,
    sourceLabel: typeof raw.sourceLabel === "string"
      ? raw.sourceLabel
      : undefined,
    forceReanalyze: raw.forceReanalyze === true || raw.force === true,
    ...parseRpcContext(raw),
  };
}

export async function buildFailedTransactionFromDirectError(
  submission: DirectErrorSubmission,
): Promise<FailedTransaction> {
  const observedAt = submission.submittedAt
    ? normalizeTimestamp(submission.submittedAt, new Date().toISOString())
    : new Date().toISOString();
  const envelopeJson = await parseEnvelopeXdr(submission.transactionXdr);
  const rpcContext = parseRpcContext(submission as unknown as Record<string, unknown>);

  if (submission.kind === "rpc_send") {
    const status = submission.response.status;
    if (status !== "ERROR") {
      throw new Error(
        `rpc_send ingestion only supports status ERROR, received ${String(status)}.`,
      );
    }

    const hash = typeof submission.response.hash === "string" &&
        submission.response.hash.length > 0
      ? submission.response.hash
      : `rpcsend-${await createSyntheticHash(JSON.stringify(submission))}`;
    const resultJson = typeof submission.response.errorResultXdr === "string"
      ? await parseResultXdr(submission.response.errorResultXdr)
      : isRecord(submission.response.errorResult)
      ? submission.response.errorResult
      : null;
    const resultKind = resultJson
      ? extractRpcSendResultKind(resultJson)
      : null;
    const diagnosticEvents = await parseDiagnosticEvents(
      submission.response.diagnosticEventsXdr ?? submission.response.diagnosticEvents,
    );
    const processingJson = buildProcessingJson(
      resultKind ?? "rpc_send_error",
      diagnosticEvents,
      pruneUndefined({
        status:
          typeof submission.response.status === "string"
            ? submission.response.status
            : undefined,
        latestLedger:
          typeof submission.response.latestLedger === "number"
            ? submission.response.latestLedger
            : undefined,
        latestLedgerCloseTime:
          typeof submission.response.latestLedgerCloseTime === "number"
            ? submission.response.latestLedgerCloseTime
            : undefined,
        errorResult: resultJson,
        sourceLabel: submission.sourceLabel,
      }),
      hash,
    );
    const decoded = buildDecodedTransactionContext(envelopeJson, processingJson);
    if (decoded.errorSignatures.length === 0) {
      decoded.errorSignatures = fallbackErrorSignatures(resultKind ?? "rpc_send_error");
    }

    const operationTypes = collectOperationTypes(envelopeJson);
    const sorobanOperationTypes = operationTypes.filter((item) =>
      item === "invoke_host_function" ||
      item === "restore_footprint" ||
      item === "extend_footprint_ttl"
    );
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
      ...new Set([
        ...primaryContractIds,
        ...decoded.touchedContractIds,
        ...collectContractIdsFromValue(envelopeJson),
      ]),
    ];

    return {
      observationKind: "rpc_send",
      txHash: hash,
      ledgerSequence:
        typeof submission.response.latestLedger === "number"
          ? submission.response.latestLedger
          : 0,
      ledgerCloseTime: normalizeTimestamp(
        submission.response.latestLedgerCloseTime,
        observedAt,
      ),
      resultKind: resultKind ?? "rpc_send_error",
      soroban: true,
      primaryContractIds,
      contractIds,
      operationTypes,
      sorobanOperationTypes,
      diagnosticEvents,
      envelopeJson,
      processingJson,
      decoded,
      readout: buildReadout(
        "rpc_send",
        resultKind ?? "rpc_send_error",
        decoded,
        contractIds,
        envelopeJson,
        submission.response,
        hash,
      ),
      rpcContext,
      sourcePayload: buildSourcePayload(submission, observedAt),
    };
  }

  const sourceReference = typeof submission.response.txHash === "string" &&
      submission.response.txHash.trim().length > 0
    ? submission.response.txHash
    : `rpcsim-${await createSyntheticHash(JSON.stringify(submission))}`;
  const diagnosticEvents = await parseDiagnosticEvents(
    submission.response.diagnosticEventsXdr ??
      submission.response.events ??
      submission.response.diagnosticEvents,
  );
  const simulationError = typeof submission.response.error === "string" &&
      submission.response.error.trim()
    ? submission.response.error
    : synthesizeSimulationError(diagnosticEvents);
  const resultJson = typeof submission.response.resultXdr === "string"
    ? await parseResultXdr(submission.response.resultXdr)
    : isRecord(submission.response.result)
    ? submission.response.result
    : null;
  const metaJson = typeof submission.response.resultMetaXdr === "string"
    ? await parseResultMetaXdr(submission.response.resultMetaXdr)
    : isRecord(submission.response.resultMeta)
    ? submission.response.resultMeta
    : null;
  const derivedResultKind = resultJson
    ? extractRpcSendResultKind(resultJson)
    : null;
  const resultKind = derivedResultKind
    ? `simulate:${derivedResultKind}`
    : simulationError
    ? `simulate:${normalizeCode(summarizeSimulationError(simulationError))}`
    : typeof submission.response.status === "string" && submission.response.status.trim()
    ? `simulate:${normalizeCode(submission.response.status)}`
    : "simulate:unknown";

  if (!simulationError && !resultJson && !metaJson && diagnosticEvents.length === 0) {
    throw new Error(
      "rpc_simulate ingestion requires an error string or rich result metadata.",
    );
  }

  const processingJson = resultJson || metaJson
    ? {
      result: {
        transaction_hash: sourceReference,
        result: resultJson ?? {
          [typeof submission.response.status === "string" &&
          submission.response.status.trim()
            ? normalizeCode(submission.response.status)
            : "simulate_failed"]: {},
        },
      },
      tx_apply_processing: normalizeTransactionMeta(metaJson, diagnosticEvents),
    }
    : buildProcessingJson(resultKind, diagnosticEvents, {
      error: simulationError,
      latestLedger:
        typeof submission.response.latestLedger === "number"
          ? submission.response.latestLedger
          : undefined,
      latestLedgerCloseTime:
        typeof submission.response.latestLedgerCloseTime === "number"
          ? submission.response.latestLedgerCloseTime
          : undefined,
      sourceLabel: submission.sourceLabel,
    }, sourceReference);
  const decoded = buildDecodedTransactionContext(envelopeJson, processingJson);
  if (decoded.errorSignatures.length === 0) {
    decoded.errorSignatures = fallbackErrorSignatures(
      resultKind,
      simulationError,
    );
  }

  const operationTypes = collectOperationTypes(envelopeJson);
  const sorobanOperationTypes = operationTypes.filter((item) =>
    item === "invoke_host_function" ||
    item === "restore_footprint" ||
    item === "extend_footprint_ttl"
  );
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
    ...new Set([
      ...primaryContractIds,
      ...decoded.touchedContractIds,
      ...collectContractIdsFromValue(envelopeJson),
    ]),
  ];

  return {
    observationKind: "rpc_simulate",
    txHash: sourceReference,
    ledgerSequence:
      typeof submission.response.latestLedger === "number"
        ? submission.response.latestLedger
        : typeof submission.response.ledger === "number"
        ? submission.response.ledger
        : 0,
    ledgerCloseTime: normalizeTimestamp(
      submission.response.createdAt ?? submission.response.latestLedgerCloseTime,
      observedAt,
    ),
    resultKind,
    soroban: true,
    primaryContractIds,
    contractIds,
    operationTypes,
    sorobanOperationTypes,
    diagnosticEvents,
    envelopeJson,
    processingJson,
    decoded,
    readout: buildReadout(
      "rpc_simulate",
      resultKind,
      decoded,
      contractIds,
      envelopeJson,
      submission.response,
      sourceReference,
      simulationError,
    ),
    rpcContext,
    sourcePayload: buildSourcePayload(submission, observedAt),
  };
}
