import { xdr } from "@stellar/stellar-sdk";
import {
  buildDecodedTransactionContext,
  collectContractIdsFromValue,
} from "./transaction.js";
import { normalizeXdrBase64 } from "./input.js";
import type {
  DirectErrorSubmission,
  ErrorReadout,
  ErrorSignature,
  FailedTransaction,
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
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallback;
}

function xdrToJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

function parseEnvelopeXdr(xdrBase64: string): unknown {
  return xdrToJson(
    xdr.TransactionEnvelope.fromXDR(normalizeXdrBase64(xdrBase64), "base64"),
  );
}

function parseResultXdr(xdrBase64: string): unknown {
  return xdrToJson(
    xdr.TransactionResult.fromXDR(normalizeXdrBase64(xdrBase64), "base64"),
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

function parseDiagnosticEvents(events: unknown): unknown[] {
  if (!Array.isArray(events)) return [];
  return events
    .flatMap((item) => {
      if (typeof item === "string" && item.length > 0) {
        return [
          xdrToJson(
            xdr.DiagnosticEvent.fromXDR(normalizeXdrBase64(item), "base64"),
          ),
        ];
      }
      if (isRecord(item)) {
        return [item];
      }
      return [];
    });
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
  const serialized = JSON.stringify(envelopeJson);
  const types: string[] = [];

  if (serialized.includes("invoke_host_function")) {
    types.push("invoke_host_function");
  }
  if (serialized.includes("restore_footprint")) {
    types.push("restore_footprint");
  }
  if (serialized.includes("extend_footprint_ttl")) {
    types.push("extend_footprint_ttl");
  }

  return types;
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
): ErrorReadout {
  const serializedEnvelope = JSON.stringify(envelopeJson);

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
    latestLedgerCloseTime:
      typeof response.latestLedgerCloseTime === "number"
        ? response.latestLedgerCloseTime
        : undefined,
    rpcStatus: typeof response.status === "string" ? response.status : undefined,
    simulationError: typeof response.error === "string" ? response.error : undefined,
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
  };
}

export async function buildFailedTransactionFromDirectError(
  submission: DirectErrorSubmission,
): Promise<FailedTransaction> {
  const observedAt = submission.submittedAt
    ? normalizeTimestamp(submission.submittedAt, new Date().toISOString())
    : new Date().toISOString();
  const envelopeJson = parseEnvelopeXdr(submission.transactionXdr);

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
      ? parseResultXdr(submission.response.errorResultXdr)
      : isRecord(submission.response.errorResult)
      ? submission.response.errorResult
      : null;
    const resultKind = resultJson
      ? extractRpcSendResultKind(resultJson)
      : null;
    const diagnosticEvents = parseDiagnosticEvents(
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
      sourcePayload: buildSourcePayload(submission, observedAt),
    };
  }

  if (typeof submission.response.error !== "string" || !submission.response.error.trim()) {
    throw new Error("rpc_simulate ingestion requires a non-empty error field.");
  }

  const sourceReference = `rpcsim-${await createSyntheticHash(JSON.stringify(submission))}`;
  const diagnosticEvents = parseDiagnosticEvents(submission.response.events);
  const resultKind = `simulate:${normalizeCode(submission.response.error)}`;
  const processingJson = buildProcessingJson(resultKind, diagnosticEvents, {
    error: submission.response.error,
    latestLedger:
      typeof submission.response.latestLedger === "number"
        ? submission.response.latestLedger
        : undefined,
    latestLedgerCloseTime:
      typeof submission.response.latestLedgerCloseTime === "number"
        ? submission.response.latestLedgerCloseTime
        : undefined,
    sourceLabel: submission.sourceLabel,
  });
  const decoded = buildDecodedTransactionContext(envelopeJson, processingJson);
  if (decoded.errorSignatures.length === 0) {
    decoded.errorSignatures = fallbackErrorSignatures(
      resultKind,
      submission.response.error,
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
        : 0,
    ledgerCloseTime: observedAt,
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
    ),
    sourcePayload: buildSourcePayload(submission, observedAt),
  };
}
