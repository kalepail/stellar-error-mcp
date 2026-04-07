import type {
  AnalysisResult,
  BuiltinContractDescriptor,
  BuiltinTxInsight,
  ContractCustomSections,
  ContractMetadata,
  Env,
  FailedTransaction,
} from "./types.js";
import { encode as encodeToon } from "@toon-format/toon";
import { buildBuiltinInsights } from "./builtin-contracts.js";

const SYSTEM_PROMPT = `You are a Stellar/Soroban blockchain error analysis expert. You will receive data about a failed, rejected, or simulated Soroban smart contract transaction on the Stellar network.

Analyze the failure and respond with a JSON object containing exactly these fields:
- "summary": A concise 2-3 sentence description of what went wrong. Name the failing contract/function path and the concrete failure mode if available.
- "errorCategory": A short machine-friendly classification derived from the observed failure. DO NOT use a fixed enum. Prefer the most specific real label available from the evidence, such as a contract-defined error name, a HostError family/code, an operation result code, or a tx result code. Examples: "contract:Error::InsufficientBalance", "host:Auth.InvalidAction", "op:INVOKE_HOST_FUNCTION_TRAPPED", "tx:txSOROBAN_INVALID"
- "likelyCause": The most probable root cause of the failure
- "suggestedFix": A concrete next debugging step or fix suggestion
- "detailedAnalysis": 2-4 short paragraphs explaining the failure path, what evidence supports the diagnosis, what was ruled out, and how the developer should reason about it
- "evidence": An array of 4-7 specific observations pulled from the transaction data, diagnostic events, resource usage, or contract spec
- "relatedCodes": An array of concrete codes or identifiers mentioned in the failure, such as tx codes, op codes, HostError labels, auth errors, or contract enum names
- "debugSteps": An array of 4-7 concrete debugging or remediation steps ordered by usefulness
- "confidence": "high", "medium", or "low" based on how much diagnostic info was available

Analyze ALL available data:
- The observation kind (ledger failure vs RPC send rejection vs simulation failure)
- The resultKind (transaction-level or simulation-level failure type)
- Extracted error signatures: these are normalized from diagnostic events and often expose the HostError family/code or contract error number
- Function calls: which function was called, with what arguments — check if arguments are invalid (zero amounts, wrong types, out of range)
- Authorization entries: check signature ledger bounds (valid_until_ledger vs actual ledger), credential types, and auth contexts for sub-contract calls
- Resource limits: compare CPU instructions, read/write bytes from the envelope against what was consumed — did the tx run out of resources?
- Diagnostic events: contract error codes, trap messages, function call traces — these show the exact execution path and where it failed
- Contract events: non-diagnostic events showing what the contract did before failing
- Transaction result details: the full result XDR showing the precise failure code path
- Full decoded transaction envelope and processing metadata: use the decoded views to inspect nested XDR blobs, addresses, result codes, contract data, and auth structures that may still be opaque in the raw JSON
- Operation-level effects and ledger changes: reason through which operation touched which contracts or ledger entries, and what state changed before the failure surfaced
- Contract specifications (if provided): use error enum definitions to map error codes to their actual names, and function signatures to understand parameter types and expected inputs
- Built-in contract/runtime context (if provided): when a contract is a host-implemented built-in such as a Stellar Asset Contract or auth runtime helper, use the virtual ABI, shared built-in error codes, and auth semantics in the prompt as authoritative context
- The readout summary fields for fee and resource overview

Rules:
- Do not invent a closed taxonomy of Soroban errors. Errors are open-ended and may come from protocol validation, host execution, auth, resources, storage, contract-defined enums, or Wasm traps.
- When contract specs expose enum cases, map numeric contract errors to those names and prefer that mapping in "errorCategory" and "relatedCodes".
- When built-in contract context exposes named shared error codes, use those names instead of leaving numeric built-in contract errors unexplained.
- Make the answer specific. Prefer naming exact contract IDs, function names, signer IDs, auth rule IDs, and error enum names from the provided evidence instead of generic descriptions.
- If the data lets you rule something out, say so explicitly in "detailedAnalysis" or "evidence" (for example signature expiration, timebounds, wrong contract, missing trustline, or resource exhaustion).
- When multiple contracts appear, explain the failure chain across them rather than only describing the top-level caller.
- If evidence is weak or ambiguous, say so in "detailedAnalysis" and lower confidence instead of overfitting.
- Keep "summary", "likelyCause", and "suggestedFix" concise, but make "detailedAnalysis" and "debugSteps" genuinely useful to a developer.`;

interface AiCompactionProfile {
  name: string;
  includeRaw: boolean;
  includeDecodedViews: boolean;
  summarizeContractSections: boolean;
  summarizeEvidence: boolean;
  includeFunctionDocs: boolean;
  includeErrorDocs: boolean;
  functionLimit: number;
  errorCaseLimit: number;
  structLimit: number;
  structFieldLimit: number;
  maxStringLength: number;
  maxDepth: number;
  shallowArrayLimit: number;
  deepArrayLimit: number;
}

interface BuiltAnalysisPrompt {
  content: string;
  profileName: string;
  toonChars: number;
}

export interface AnalysisProgressUpdate {
  phase:
    | "profile_start"
    | "attempt_start"
    | "attempt_heartbeat"
    | "retry_scheduled"
    | "success"
    | "failed";
  modelId: string;
  profileName: string;
  attempt: number;
  elapsedMs: number;
  timeoutMs: number;
  maxDurationMs: number;
  toonChars?: number;
  remainingMs?: number;
  delayMs?: number;
  error?: string;
}

export interface AnalyzeFailedTransactionOptions {
  onProgress?: (update: AnalysisProgressUpdate) => Promise<void> | void;
}

const ANALYSIS_PROMPT_CHAR_BUDGET = 50000;
const TOON_TAB_DELIMITER = "\t";
const CONTRACT_SECTION_PREVIEW_LIMIT = 1200;
const ANALYSIS_PROMPT_PROFILES: AiCompactionProfile[] = [
  {
    name: "full",
    includeRaw: true,
    includeDecodedViews: true,
    summarizeContractSections: false,
    summarizeEvidence: false,
    includeFunctionDocs: true,
    includeErrorDocs: true,
    functionLimit: 32,
    errorCaseLimit: 64,
    structLimit: 24,
    structFieldLimit: 24,
    maxStringLength: 50000,
    maxDepth: 14,
    shallowArrayLimit: 200,
    deepArrayLimit: 120,
  },
  {
    name: "contract_section_summaries",
    includeRaw: true,
    includeDecodedViews: true,
    summarizeContractSections: true,
    summarizeEvidence: false,
    includeFunctionDocs: true,
    includeErrorDocs: true,
    functionLimit: 24,
    errorCaseLimit: 48,
    structLimit: 20,
    structFieldLimit: 20,
    maxStringLength: 50000,
    maxDepth: 14,
    shallowArrayLimit: 200,
    deepArrayLimit: 120,
  },
  {
    name: "no_raw_mirrors",
    includeRaw: false,
    includeDecodedViews: true,
    summarizeContractSections: true,
    summarizeEvidence: false,
    includeFunctionDocs: false,
    includeErrorDocs: true,
    functionLimit: 18,
    errorCaseLimit: 32,
    structLimit: 16,
    structFieldLimit: 16,
    maxStringLength: 40000,
    maxDepth: 12,
    shallowArrayLimit: 160,
    deepArrayLimit: 100,
  },
  {
    name: "no_duplicate_views",
    includeRaw: false,
    includeDecodedViews: false,
    summarizeContractSections: true,
    summarizeEvidence: true,
    includeFunctionDocs: false,
    includeErrorDocs: false,
    functionLimit: 14,
    errorCaseLimit: 20,
    structLimit: 12,
    structFieldLimit: 12,
    maxStringLength: 40000,
    maxDepth: 12,
    shallowArrayLimit: 160,
    deepArrayLimit: 100,
  },
  {
    name: "compact",
    includeRaw: false,
    includeDecodedViews: false,
    summarizeContractSections: true,
    summarizeEvidence: true,
    includeFunctionDocs: false,
    includeErrorDocs: false,
    functionLimit: 10,
    errorCaseLimit: 12,
    structLimit: 8,
    structFieldLimit: 8,
    maxStringLength: 20000,
    maxDepth: 10,
    shallowArrayLimit: 120,
    deepArrayLimit: 60,
  },
  {
    name: "tight",
    includeRaw: false,
    includeDecodedViews: false,
    summarizeContractSections: true,
    summarizeEvidence: true,
    includeFunctionDocs: false,
    includeErrorDocs: false,
    functionLimit: 6,
    errorCaseLimit: 8,
    structLimit: 6,
    structFieldLimit: 6,
    maxStringLength: 10000,
    maxDepth: 8,
    shallowArrayLimit: 80,
    deepArrayLimit: 40,
  },
  {
    name: "minimal",
    includeRaw: false,
    includeDecodedViews: false,
    summarizeContractSections: true,
    summarizeEvidence: true,
    includeFunctionDocs: false,
    includeErrorDocs: false,
    functionLimit: 4,
    errorCaseLimit: 5,
    structLimit: 4,
    structFieldLimit: 4,
    maxStringLength: 1000,
    maxDepth: 6,
    shallowArrayLimit: 20,
    deepArrayLimit: 8,
  },
  {
    name: "nano",
    includeRaw: false,
    includeDecodedViews: false,
    summarizeContractSections: true,
    summarizeEvidence: true,
    includeFunctionDocs: false,
    includeErrorDocs: false,
    functionLimit: 3,
    errorCaseLimit: 4,
    structLimit: 2,
    structFieldLimit: 3,
    maxStringLength: 400,
    maxDepth: 5,
    shallowArrayLimit: 12,
    deepArrayLimit: 4,
  },
];

function buildUserPrompt(
  tx: FailedTransaction,
  contracts?: Map<string, ContractMetadata>,
  profileIndex = 0,
): BuiltAnalysisPrompt {
  const profile = ANALYSIS_PROMPT_PROFILES[profileIndex];
  if (!profile) {
    return {
      content: "",
      profileName: "empty",
      toonChars: 0,
    };
  }

  const aiPayload = compactForAi({
    transaction: {
      txHash: tx.txHash,
      observationKind: tx.observationKind,
      rpcContext: tx.rpcContext ?? null,
      ledgerSequence: tx.ledgerSequence,
      ledgerCloseTime: tx.ledgerCloseTime,
      resultKind: tx.resultKind,
      operationTypes: tx.operationTypes,
      sorobanOperationTypes: tx.sorobanOperationTypes,
      contractIds: tx.contractIds,
      topLevelFunction: tx.decoded.topLevelFunction,
      readout: tx.readout,
    },
    evidence: {
      errorSignatures: tx.decoded.errorSignatures,
      invokeCalls: profile.summarizeEvidence
        ? summarizeInvokeCalls(tx)
        : tx.decoded.invokeCalls,
      authEntries: profile.summarizeEvidence
        ? summarizeAuthEntries(tx, profile)
        : tx.decoded.authEntries,
      resourceLimits: tx.decoded.resourceLimits,
      transactionResult: profile.summarizeEvidence
        ? summarizeUnknownValue(tx.decoded.transactionResult, profile)
        : tx.decoded.transactionResult,
      diagnosticEvents: profile.summarizeEvidence
        ? summarizeEventCollection(tx.decoded.diagnosticEvents, profile)
        : tx.decoded.diagnosticEvents,
      contractEvents: profile.summarizeEvidence
        ? summarizeEventCollection(tx.decoded.contractEvents, profile)
        : tx.decoded.contractEvents,
      sorobanMeta: profile.summarizeEvidence
        ? summarizeUnknownValue(tx.decoded.sorobanMeta, profile)
        : tx.decoded.sorobanMeta,
      operationEffects: profile.summarizeEvidence
        ? summarizeProcessingOperations(tx, profile)
        : tx.decoded.processingOperations,
      ledgerChanges: profile.summarizeEvidence
        ? summarizeLedgerChanges(tx, profile)
        : tx.decoded.ledgerChanges,
      touchedContractIds: tx.decoded.touchedContractIds,
    },
    raw: profile.includeRaw
      ? {
        envelope: tx.envelopeJson,
        processing: tx.processingJson,
      }
      : undefined,
    decoded: profile.includeDecodedViews
      ? {
        envelope: tx.decoded.decodedEnvelope ?? null,
        processing: tx.decoded.decodedProcessing ?? null,
      }
      : undefined,
    contracts: summarizeContracts(tx, contracts, profile),
    builtinInsights: summarizeBuiltinInsights(
      buildBuiltinInsights(tx, contracts),
      profile,
    ),
  }, profile);

  const toon = encodeToon(aiPayload, {
    keyFolding: "safe",
    delimiter: TOON_TAB_DELIMITER,
  });
  const content = [
    "The following document is TOON, a lossless structured encoding of JSON optimized for LLM input.",
    "Interpret it as structured data. Arrays may use [N] lengths, uniform object arrays may use {field,...} headers, and tabular rows may be tab-separated.",
    "```toon",
    toon,
    "```",
  ].join("\n\n");

  return {
    content,
    profileName: profile.name,
    toonChars: toon.length,
  };
}

function summarizeInvokeCalls(tx: FailedTransaction): unknown[] {
  return tx.decoded.invokeCalls.slice(0, 8).map((call) => ({
    contractId: call.contractId ?? null,
    functionName: call.functionName ?? null,
    argCount: call.argCount ?? (Array.isArray(call.args) ? call.args.length : undefined),
    authCount: call.authCount ?? (Array.isArray(call.auth) ? call.auth.length : undefined),
  }));
}

function summarizeAuthEntries(
  tx: FailedTransaction,
  profile: AiCompactionProfile,
): Record<string, unknown> {
  return {
    count: tx.decoded.authEntries.length,
    preview: tx.decoded.authEntries
      .slice(0, Math.max(1, Math.min(profile.deepArrayLimit, 4)))
      .map((entry) => compactForAi(entry, profile, 2)),
  };
}

function summarizeUnknownValue(
  value: unknown,
  profile: AiCompactionProfile,
): unknown {
  return compactForAi(value, profile, 2);
}

function summarizeEventCollection(
  events: unknown[],
  profile: AiCompactionProfile,
): Record<string, unknown> {
  const limit = Math.max(1, Math.min(profile.deepArrayLimit, 6));
  return {
    count: events.length,
    preview: events.slice(0, limit).map((event) => compactForAi(event, profile, 2)),
  };
}

function summarizeProcessingOperations(
  tx: FailedTransaction,
  profile: AiCompactionProfile,
): unknown[] {
  const limit = Math.max(1, Math.min(profile.deepArrayLimit, 6));
  return tx.decoded.processingOperations.slice(0, limit).map((operation) => ({
    index: operation.index,
    operationType: operation.operationType ?? null,
    sourceAccount: operation.sourceAccount ?? null,
    changeCount: operation.changeCount,
    eventCount: operation.eventCount,
    diagnosticEventCount: operation.diagnosticEventCount,
    touchedContractIds: operation.touchedContractIds.slice(0, 6),
    processing: compactForAi(operation.processing, profile, 3),
  }));
}

function summarizeLedgerChanges(
  tx: FailedTransaction,
  profile: AiCompactionProfile,
): unknown[] {
  const limit = Math.max(1, Math.min(profile.deepArrayLimit, 8));
  return tx.decoded.ledgerChanges.slice(0, limit).map((change) => ({
    operationIndex: change.operationIndex,
    changeType: change.changeType ?? null,
    ledgerEntryType: change.ledgerEntryType ?? null,
    contractIds: change.contractIds.slice(0, 6),
    change: compactForAi(change.change, profile, 3),
  }));
}

function summarizeContracts(
  tx: FailedTransaction,
  contracts: Map<string, ContractMetadata> | undefined,
  profile: AiCompactionProfile,
): unknown[] {
  if (!contracts || contracts.size === 0) return [];

  return [...contracts.values()].map((meta) => ({
    contractId: meta.contractId,
    wasmHash: meta.wasmHash,
    contractType: meta.contractType ?? null,
    builtin: summarizeBuiltinDescriptor(meta.builtin),
    notes: meta.notes ?? [],
    assetMetadata: meta.assetMetadata ?? null,
    functions: summarizeFunctions(tx, meta, profile),
    errorEnums: summarizeErrorEnums(tx, meta, profile),
    structs: summarizeStructs(meta, profile),
    customSections: profile.summarizeContractSections
      ? summarizeContractSections(meta.customSections)
      : meta.customSections,
  }));
}

function summarizeFunctions(
  tx: FailedTransaction,
  meta: ContractMetadata,
  profile: AiCompactionProfile,
): unknown[] {
  const prioritizedNames = new Set<string>();
  if (meta.contractId === tx.primaryContractIds[0] && tx.decoded.topLevelFunction) {
    prioritizedNames.add(tx.decoded.topLevelFunction);
  }
  for (const call of tx.decoded.invokeCalls) {
    if (
      call.contractId === meta.contractId &&
      typeof call.functionName === "string" &&
      call.functionName.length > 0
    ) {
      prioritizedNames.add(call.functionName);
    }
  }
  if (meta.builtin?.kind === "account_contract") prioritizedNames.add("__check_auth");

  const prioritized = meta.functions.filter((fn) => prioritizedNames.has(fn.name));
  const remaining = meta.functions.filter((fn) => !prioritizedNames.has(fn.name));
  const selected = [...prioritized, ...remaining].slice(0, profile.functionLimit);

  return selected.map((fn) => ({
    name: fn.name,
    inputs: fn.inputs,
    outputs: fn.outputs,
    doc: profile.includeFunctionDocs ? fn.doc : undefined,
  }));
}

function summarizeErrorEnums(
  tx: FailedTransaction,
  meta: ContractMetadata,
  profile: AiCompactionProfile,
): unknown[] {
  const relatedCodeFragments = new Set<string>();
  for (const signature of tx.decoded.errorSignatures) {
    relatedCodeFragments.add(signature.code.toLowerCase());
  }

  return meta.errorEnums.map((errorEnum) => {
    const matchingCases = errorEnum.cases.filter((errorCase) =>
      relatedCodeFragments.has(errorCase.name.toLowerCase()) ||
      relatedCodeFragments.has(String(errorCase.value).toLowerCase())
    );
    const nonMatchingCases = errorEnum.cases.filter((errorCase) =>
      !matchingCases.includes(errorCase)
    );
    const selectedCases = [...matchingCases, ...nonMatchingCases]
      .slice(0, profile.errorCaseLimit)
      .map((errorCase) => ({
        name: errorCase.name,
        value: errorCase.value,
        doc: profile.includeErrorDocs ? errorCase.doc : undefined,
      }));

    return {
      name: errorEnum.name,
      caseCount: errorEnum.cases.length,
      cases: selectedCases,
    };
  });
}

function summarizeStructs(
  meta: ContractMetadata,
  profile: AiCompactionProfile,
): unknown[] {
  return meta.structs
    .slice(0, profile.structLimit)
    .map((struct) => ({
      name: struct.name,
      fieldCount: struct.fields.length,
      fields: struct.fields.slice(0, profile.structFieldLimit),
    }));
}

function summarizeBuiltinDescriptor(
  builtin: BuiltinContractDescriptor | undefined,
): Record<string, unknown> | null {
  if (!builtin) return null;

  return {
    kind: builtin.kind,
    name: builtin.name,
    summary: builtin.summary,
    detectionReason: builtin.detectionReason ?? null,
    notes: builtin.notes ?? [],
    authSemantics: builtin.authSemantics ?? [],
    failureModes: builtin.failureModes ?? [],
    sourceRefs: builtin.sourceRefs,
  };
}

function summarizeBuiltinInsights(
  insights: BuiltinTxInsight[],
  profile: AiCompactionProfile,
): unknown[] {
  if (insights.length === 0) return [];

  return insights.map((insight) => ({
    kind: insight.kind,
    title: insight.title,
    summary: insight.summary,
    trigger: insight.trigger,
    relatedFunctions: insight.relatedFunctions ?? [],
    relatedCodes: insight.relatedCodes ?? [],
    debugHints: insight.debugHints ?? [],
    sourceRefs: insight.sourceRefs,
    profile: profile.name,
  }));
}

function summarizeContractSections(
  customSections?: ContractCustomSections,
): Record<string, unknown> | null {
  if (!customSections) return null;

  return {
    contractspecv0Entries: customSections.contractspecv0?.length ?? 0,
    contractmetav0Entries: customSections.contractmetav0?.length ?? 0,
    contractenvmetav0Entries: customSections.contractenvmetav0?.length ?? 0,
    contractmetav0Preview: previewSection(customSections.contractmetav0),
    contractenvmetav0Preview: previewSection(customSections.contractenvmetav0),
  };
}

function previewSection(entries?: unknown[]): string | null {
  if (!entries || entries.length === 0) return null;

  const preview = JSON.stringify(entries.slice(0, 2));
  return preview.length > CONTRACT_SECTION_PREVIEW_LIMIT
    ? `${preview.slice(0, CONTRACT_SECTION_PREVIEW_LIMIT)}... [truncated]`
    : preview;
}

function compactForAi(
  value: unknown,
  profile: AiCompactionProfile,
  depth = 0,
): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    return value.length > profile.maxStringLength
      ? `${value.slice(0, profile.maxStringLength)}... [truncated]`
      : value;
  }
  if (typeof value !== "object") return value;
  if (depth >= profile.maxDepth) return "[max-depth]";

  if (Array.isArray(value)) {
    const limit = depth <= 1 ? profile.shallowArrayLimit : profile.deepArrayLimit;
    const items = value
      .slice(0, limit)
      .map((item) => compactForAi(item, profile, depth + 1));
    if (value.length > limit) {
      items.push({
        _truncated: true,
        keptItems: limit,
        remainingItems: value.length - limit,
      });
    }
    return items;
  }

  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner === undefined) continue;
    output[key] = compactForAi(inner, profile, depth + 1);
  }
  return output;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function normalizeStringArray(
  value: unknown,
  fallback: string[] = [],
  maxItems = 5,
): string[] {
  if (!Array.isArray(value)) return fallback;

  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);

  if (normalized.length === 0) return fallback;
  return normalized.slice(0, maxItems);
}

const MAX_COMPLETION_TOKENS = 8192;
const DEFAULT_AI_TIMEOUT_MS = 45000;
const DEFAULT_AI_MAX_DURATION_MS = 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60000;
const AI_PROGRESS_HEARTBEAT_MS = 30000;
const MAX_TRANSPORT_RETRIES_PER_PROFILE = 3;
const ANALYSIS_RESPONSE_SCHEMA = {
  name: "stellar_error_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "errorCategory",
      "likelyCause",
      "suggestedFix",
      "detailedAnalysis",
      "evidence",
      "relatedCodes",
      "debugSteps",
      "confidence",
    ],
    properties: {
      summary: { type: "string" },
      errorCategory: { type: "string" },
      likelyCause: { type: "string" },
      suggestedFix: { type: "string" },
      detailedAnalysis: { type: "string" },
      evidence: {
        type: "array",
        items: { type: "string" },
      },
      relatedCodes: {
        type: "array",
        items: { type: "string" },
      },
      debugSteps: {
        type: "array",
        items: { type: "string" },
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
    },
  },
} as const;

function resolveAiTimeoutMs(env: Env): number {
  const raw = Number(env.AI_ANALYSIS_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 1000) {
    return Math.floor(raw);
  }
  return DEFAULT_AI_TIMEOUT_MS;
}

function resolveAiMaxDurationMs(env: Env): number {
  const raw = Number(env.AI_ANALYSIS_MAX_DURATION_MS);
  if (Number.isFinite(raw) && raw >= 1000) {
    return Math.floor(raw);
  }
  return DEFAULT_AI_MAX_DURATION_MS;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const guardedPromise = promise.catch((error) => {
    if (settled) {
      console.warn(JSON.stringify({
        level: "warn",
        event: "analysis.late_rejection",
        label,
        error: error instanceof Error ? error.message : String(error),
      }));
      return new Promise<T>(() => undefined);
    }
    throw error;
  });
  try {
    const result = await Promise.race([
      guardedPromise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    settled = true;
    return result;
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
  }
}

async function reportAnalysisProgress(
  options: AnalyzeFailedTransactionOptions | undefined,
  update: AnalysisProgressUpdate,
): Promise<void> {
  try {
    await options?.onProgress?.(update);
  } catch {
    // Progress reporting must not break analysis.
  }
}

async function runAIWithRetry(
  env: Env,
  messages: Array<{ role: string; content: string }>,
  modelId: string,
  deadlineAt: number,
  maxDurationMs: number,
  prompt: BuiltAnalysisPrompt,
  options: AnalyzeFailedTransactionOptions | undefined,
  analysisStartedAt: number,
  sessionAffinity: string,
): Promise<{ text: string; usedModel: string }> {
  const timeoutMs = resolveAiTimeoutMs(env);
  let attempt = 0;
  let lastError: Error | null = null;
  let transportRetryCount = 0;

  while (Date.now() < deadlineAt) {
    attempt += 1;
    const attemptStartedAt = Date.now();
    await reportAnalysisProgress(options, {
      phase: "attempt_start",
      modelId,
      profileName: prompt.profileName,
      attempt,
      elapsedMs: attemptStartedAt - analysisStartedAt,
      timeoutMs,
      maxDurationMs,
      toonChars: prompt.toonChars,
      remainingMs: Math.max(0, deadlineAt - attemptStartedAt),
    });

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      heartbeat = setInterval(() => {
        void reportAnalysisProgress(options, {
          phase: "attempt_heartbeat",
          modelId,
          profileName: prompt.profileName,
          attempt,
          elapsedMs: Date.now() - analysisStartedAt,
          timeoutMs,
          maxDurationMs,
          toonChars: prompt.toonChars,
          remainingMs: Math.max(0, deadlineAt - Date.now()),
        });
      }, AI_PROGRESS_HEARTBEAT_MS);

      const response: any = await withTimeout(
        env.AI.run(modelId as any, {
          messages,
          temperature: 0.1,
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          response_format: {
            type: "json_schema",
            json_schema: ANALYSIS_RESPONSE_SCHEMA,
          },
          chat_template_kwargs: {
            enable_thinking: false,
          },
        }, {
          headers: {
            "x-session-affinity": sessionAffinity,
          },
        } as any),
        timeoutMs,
        `AI model ${modelId}`,
      );

      let text: string | null = null;
      if (typeof response === "string") {
        text = response;
      } else if (typeof response?.response === "string") {
        text = response.response;
      } else if (response?.response && typeof response.response === "object") {
        text = JSON.stringify(response.response);
      } else if (typeof response?.choices?.[0]?.message?.content === "string") {
        text = response.choices[0].message.content;
      } else if (Array.isArray(response?.choices?.[0]?.message?.content)) {
        text = response.choices[0].message.content
          .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
          .join("")
          .trim() || null;
      }

      if (!text) {
        if (response?.choices?.[0]?.finish_reason === "length") {
          throw new Error("AI response truncated (finish_reason: length)");
        }
        throw new Error(
          `Empty AI response (finish_reason: ${response?.choices?.[0]?.finish_reason})`,
        );
      }

      await reportAnalysisProgress(options, {
        phase: "success",
        modelId,
        profileName: prompt.profileName,
        attempt,
        elapsedMs: Date.now() - analysisStartedAt,
        timeoutMs,
        maxDurationMs,
        toonChars: prompt.toonChars,
        remainingMs: Math.max(0, deadlineAt - Date.now()),
      });

      return { text, usedModel: modelId };
    } catch (error) {
      const wrappedError = error instanceof Error ? error : new Error(String(error));
      lastError = wrappedError;
      const message = wrappedError.message;

      if (isContextWindowError(message)) {
        throw wrappedError;
      }

      const isRetryable = isRetryableAiError(message);

      if (!isRetryable) {
        throw wrappedError;
      }

      transportRetryCount += 1;
      if (transportRetryCount >= MAX_TRANSPORT_RETRIES_PER_PROFILE) {
        throw new Error(
          `AI transport retry limit reached for profile ${prompt.profileName}: ${message}`,
        );
      }

      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 6), MAX_RETRY_DELAY_MS);
      await reportAnalysisProgress(options, {
        phase: "retry_scheduled",
        modelId,
        profileName: prompt.profileName,
        attempt,
        elapsedMs: Date.now() - analysisStartedAt,
        timeoutMs,
        maxDurationMs,
        toonChars: prompt.toonChars,
        remainingMs,
        delayMs: Math.min(delay, remainingMs),
        error: message,
      });
      console.warn(JSON.stringify({
        level: "warn",
        event: "analysis.retry",
        model: modelId,
        attempt,
        delayMs: Math.min(delay, remainingMs),
        timeoutMs,
        remainingMs,
        error: message,
      }));
      await new Promise((r) => setTimeout(r, Math.min(delay, remainingMs)));
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  await reportAnalysisProgress(options, {
    phase: "failed",
    modelId,
    profileName: prompt.profileName,
    attempt,
    elapsedMs: Date.now() - analysisStartedAt,
    timeoutMs,
    maxDurationMs,
    toonChars: prompt.toonChars,
    remainingMs: 0,
    error: lastError?.message,
  });

  if (lastError) {
    throw new Error(
      `AI model ${modelId} exhausted after ${attempt} attempts within ${maxDurationMs}ms: ${lastError.message}`,
    );
  }
  throw new Error(
    `AI model ${modelId} exhausted without a response within ${maxDurationMs}ms`,
  );
}

function isContextWindowError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("context window") ||
    normalized.includes("context window limit") ||
    normalized.includes("maximum context length") ||
    normalized.includes("maximum context") ||
    normalized.includes("too many tokens");
}

function isTimeoutError(message: string): boolean {
  return message.toLowerCase().includes("timeout");
}

function isOutputTruncationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("finish_reason: length") ||
    normalized.includes("response truncated");
}

function isMalformedJsonResponseError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("unterminated string in json") ||
    normalized.includes("unexpected end of json input") ||
    normalized.includes("unexpected non-whitespace character after json") ||
    normalized.includes("expected ',' or '}' after property value");
}

function isRetryableAiError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("504") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("gateway") ||
    normalized.includes("network connection lost") ||
    normalized.includes("connection lost") ||
    normalized.includes("econnreset") ||
    normalized.includes("fetch failed") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("overloaded") ||
    isTimeoutError(message);
}

function isTransportRetryLimitError(message: string): boolean {
  return message.toLowerCase().includes("transport retry limit reached");
}

function extractJsonCandidate(text: string): string {
  let candidate = text.trim();
  const fencedMatch = candidate.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fencedMatch) {
    candidate = fencedMatch[1].trim();
  } else {
    candidate = candidate
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }

  return candidate;
}

export async function analyzeFailedTransaction(
  env: Env,
  tx: FailedTransaction,
  contracts?: Map<string, ContractMetadata>,
  options?: AnalyzeFailedTransactionOptions,
): Promise<AnalysisResult> {
  const modelId = env.AI_ANALYSIS_MODEL;
  const analysisMaxDurationMs = resolveAiMaxDurationMs(env);
  const analysisStartedAt = Date.now();
  const deadlineAt = Date.now() + analysisMaxDurationMs;

  try {
    for (let profileIndex = 0; profileIndex < ANALYSIS_PROMPT_PROFILES.length; profileIndex++) {
      if (Date.now() >= deadlineAt) {
        throw new Error(
          `AI model ${modelId} exhausted without a response within ${analysisMaxDurationMs}ms`,
        );
      }
      const prompt = buildUserPrompt(tx, contracts, profileIndex);
      await reportAnalysisProgress(options, {
        phase: "profile_start",
        modelId,
        profileName: prompt.profileName,
        attempt: 0,
        elapsedMs: Date.now() - analysisStartedAt,
        timeoutMs: resolveAiTimeoutMs(env),
        maxDurationMs: analysisMaxDurationMs,
        toonChars: prompt.toonChars,
        remainingMs: Math.max(0, deadlineAt - Date.now()),
      });
      if (prompt.toonChars > ANALYSIS_PROMPT_CHAR_BUDGET) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "analysis.prompt_budget_skip",
          txHash: tx.txHash,
          profile: prompt.profileName,
          toonChars: prompt.toonChars,
        }));
        continue;
      }
      if (prompt.profileName !== ANALYSIS_PROMPT_PROFILES[0].name) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "analysis.prompt_compacted",
          txHash: tx.txHash,
          profile: prompt.profileName,
          toonChars: prompt.toonChars,
        }));
      }

      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt.content },
      ];

      try {
        const { text, usedModel } = await runAIWithRetry(
          env,
          messages,
          modelId,
          deadlineAt,
          analysisMaxDurationMs,
          prompt,
          options,
          analysisStartedAt,
          `stellar-error:${tx.txHash}`,
        );

        const parsed = JSON.parse(extractJsonCandidate(text));

        return {
          txHash: tx.txHash,
          summary: normalizeString(
            parsed.summary,
            "Analysis could not produce a summary",
          ),
          errorCategory: normalizeString(parsed.errorCategory, "unclassified"),
          likelyCause: normalizeString(parsed.likelyCause, "Unknown"),
          suggestedFix: normalizeString(
            parsed.suggestedFix,
            "Review diagnostic events manually",
          ),
          detailedAnalysis: normalizeString(
            parsed.detailedAnalysis,
            "The model did not provide a detailed analysis. Review the transaction result, diagnostic events, and contract specification manually.",
          ),
          evidence: normalizeStringArray(parsed.evidence),
          relatedCodes: normalizeStringArray(parsed.relatedCodes),
          debugSteps: normalizeStringArray(parsed.debugSteps, [
            "Inspect the transaction result and operation result codes.",
            "Review diagnostic events and authorization entries for the failing path.",
          ]),
          confidence: parsed.confidence ?? "low",
          analyzedAt: new Date().toISOString(),
          modelId: usedModel,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          (
            isContextWindowError(message) ||
            isTimeoutError(message) ||
            isOutputTruncationError(message) ||
            isMalformedJsonResponseError(message) ||
            isTransportRetryLimitError(message)
          ) &&
          Date.now() < deadlineAt &&
          profileIndex < ANALYSIS_PROMPT_PROFILES.length - 1
        ) {
          console.warn(JSON.stringify({
            level: "warn",
            event: "analysis.prompt_fallback",
            txHash: tx.txHash,
            profile: prompt.profileName,
            nextProfile: ANALYSIS_PROMPT_PROFILES[profileIndex + 1]?.name,
            error: message,
          }));
          continue;
        }
        throw error;
      }
    }

    throw new Error("All analysis prompt profiles exhausted");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reportAnalysisProgress(options, {
      phase: "failed",
      modelId,
      profileName: "final",
      attempt: 0,
      elapsedMs: Date.now() - analysisStartedAt,
      timeoutMs: resolveAiTimeoutMs(env),
      maxDurationMs: analysisMaxDurationMs,
      remainingMs: Math.max(0, deadlineAt - Date.now()),
      error: message,
    });
    console.error(JSON.stringify({
      level: "error",
      event: "analysis.failed",
      txHash: tx.txHash,
      error: message,
    }));

    return {
      txHash: tx.txHash,
      summary: `AI analysis unavailable: Kimi did not return a usable response. ${message}`,
      errorCategory: "analysis:kimi_unavailable",
      likelyCause: "Workers AI could not complete analysis with the configured Kimi model within the retry window.",
      suggestedFix: "Retry analysis with Kimi later or inspect the stored normalized transaction and diagnostic evidence manually.",
      detailedAnalysis:
        "The analysis pipeline is configured to require the Kimi model for final diagnosis. Kimi did not return a usable result within the configured retry window, so the service intentionally did not fall back to a smaller-context model. Use the stored normalized transaction, diagnostic events, built-in contract context, and contract metadata for manual debugging or retry the same job when Workers AI is healthier.",
      evidence: [],
      relatedCodes: [],
      debugSteps: [
        `Retry the analysis job with ${modelId} once Workers AI latency recovers.`,
        "Review the stored transaction envelope and processing metadata manually.",
        "Decode the transaction/result XDR and inspect diagnostic events.",
      ],
      confidence: "failed",
      analyzedAt: new Date().toISOString(),
      modelId,
    };
  }
}
