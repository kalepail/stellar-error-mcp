import type {
  AnalysisResult,
  ContractCustomSections,
  ContractMetadata,
  Env,
  FailedTransaction,
} from "./types.js";
import { encode as encodeToon } from "@toon-format/toon";

const SYSTEM_PROMPT = `You are a Stellar/Soroban blockchain error analysis expert. You will receive data about a failed, rejected, or simulated Soroban smart contract transaction on the Stellar network.

Analyze the failure and respond with a JSON object containing exactly these fields:
- "summary": A concise 1-2 sentence description of what went wrong
- "errorCategory": A short machine-friendly classification derived from the observed failure. DO NOT use a fixed enum. Prefer the most specific real label available from the evidence, such as a contract-defined error name, a HostError family/code, an operation result code, or a tx result code. Examples: "contract:Error::InsufficientBalance", "host:Auth.InvalidAction", "op:INVOKE_HOST_FUNCTION_TRAPPED", "tx:txSOROBAN_INVALID"
- "likelyCause": The most probable root cause of the failure
- "suggestedFix": A concrete next debugging step or fix suggestion
- "detailedAnalysis": 1-3 short paragraphs explaining the failure path, what evidence supports the diagnosis, and how the developer should reason about it
- "evidence": An array of 2-5 specific observations pulled from the transaction data, diagnostic events, resource usage, or contract spec
- "relatedCodes": An array of concrete codes or identifiers mentioned in the failure, such as tx codes, op codes, HostError labels, auth errors, or contract enum names
- "debugSteps": An array of 2-5 concrete debugging or remediation steps ordered by usefulness
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
- The readout summary fields for fee and resource overview

Rules:
- Do not invent a closed taxonomy of Soroban errors. Errors are open-ended and may come from protocol validation, host execution, auth, resources, storage, contract-defined enums, or Wasm traps.
- When contract specs expose enum cases, map numeric contract errors to those names and prefer that mapping in "errorCategory" and "relatedCodes".
- If evidence is weak or ambiguous, say so in "detailedAnalysis" and lower confidence instead of overfitting.
- Keep "summary", "likelyCause", and "suggestedFix" concise, but make "detailedAnalysis" and "debugSteps" genuinely useful to a developer.`;

interface AiCompactionProfile {
  name: string;
  includeRaw: boolean;
  includeDecodedViews: boolean;
  summarizeContractSections: boolean;
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

const ANALYSIS_PROMPT_CHAR_BUDGET = 450000;
const TOON_TAB_DELIMITER = "\t";
const CONTRACT_SECTION_PREVIEW_LIMIT = 1200;
const ANALYSIS_PROMPT_PROFILES: AiCompactionProfile[] = [
  {
    name: "full",
    includeRaw: true,
    includeDecodedViews: true,
    summarizeContractSections: false,
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
    maxStringLength: 10000,
    maxDepth: 8,
    shallowArrayLimit: 80,
    deepArrayLimit: 40,
  },
];

function buildUserPrompt(
  tx: FailedTransaction,
  contracts?: Map<string, ContractMetadata>,
): BuiltAnalysisPrompt {
  let lastAttempt: BuiltAnalysisPrompt | null = null;

  for (const profile of ANALYSIS_PROMPT_PROFILES) {
    const aiPayload = compactForAi({
      transaction: {
        txHash: tx.txHash,
        observationKind: tx.observationKind,
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
        invokeCalls: tx.decoded.invokeCalls,
        authEntries: tx.decoded.authEntries,
        resourceLimits: tx.decoded.resourceLimits,
        transactionResult: tx.decoded.transactionResult,
        diagnosticEvents: tx.decoded.diagnosticEvents,
        contractEvents: tx.decoded.contractEvents,
        sorobanMeta: tx.decoded.sorobanMeta,
        operationEffects: tx.decoded.processingOperations,
        ledgerChanges: tx.decoded.ledgerChanges,
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
      contracts: summarizeContracts(contracts, profile),
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

    lastAttempt = {
      content,
      profileName: profile.name,
      toonChars: toon.length,
    };
    if (toon.length <= ANALYSIS_PROMPT_CHAR_BUDGET) {
      return lastAttempt;
    }
  }

  return lastAttempt ?? {
    content: "",
    profileName: "empty",
    toonChars: 0,
  };
}

function summarizeContracts(
  contracts: Map<string, ContractMetadata> | undefined,
  profile: AiCompactionProfile,
): unknown[] {
  if (!contracts || contracts.size === 0) return [];

  return [...contracts.values()].map((meta) => ({
    contractId: meta.contractId,
    wasmHash: meta.wasmHash,
    functions: meta.functions,
    errorEnums: meta.errorEnums,
    structs: meta.structs,
    customSections: profile.summarizeContractSections
      ? summarizeContractSections(meta.customSections)
      : meta.customSections,
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

const FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_COMPLETION_TOKENS = 8192;
const MAX_RETRIES = 2;
const RETRY_DELAYS = [2000, 5000]; // ms

async function runAIWithRetry(
  env: Env,
  messages: Array<{ role: string; content: string }>,
  modelId: string,
): Promise<{ text: string; usedModel: string }> {
  const models = [modelId, FALLBACK_MODEL];

  for (const model of models) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response: any = await env.AI.run(model as any, {
          messages,
          temperature: 0.3,
          max_completion_tokens: MAX_COMPLETION_TOKENS,
        });

        let text: string | null = null;
        if (typeof response === "string") {
          text = response;
        } else if (response?.response) {
          text = response.response;
        } else if (typeof response?.choices?.[0]?.message?.content === "string") {
          text = response.choices[0].message.content;
        } else if (Array.isArray(response?.choices?.[0]?.message?.content)) {
          text = response.choices[0].message.content
            .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
            .join("")
            .trim() || null;
        }

        if (!text) {
          throw new Error(
            `Empty AI response (finish_reason: ${response?.choices?.[0]?.finish_reason})`,
          );
        }

        return { text, usedModel: model };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isRetryable =
          message.includes("504") ||
          message.includes("502") ||
          message.includes("503") ||
          message.includes("Gateway") ||
          message.includes("timeout");

        if (!isRetryable || attempt === MAX_RETRIES) {
          if (model !== models[models.length - 1]) {
            console.warn(JSON.stringify({
              level: "warn",
              event: "analysis.model_fallback",
              model,
              attempts: attempt + 1,
            }));
            break; // try next model
          }
          throw error;
        }

        const delay = RETRY_DELAYS[attempt] ?? 5000;
        console.warn(JSON.stringify({
          level: "warn",
          event: "analysis.retry",
          model,
          attempt: attempt + 1,
          delayMs: delay,
        }));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw new Error("All AI models exhausted");
}

export async function analyzeFailedTransaction(
  env: Env,
  tx: FailedTransaction,
  contracts?: Map<string, ContractMetadata>,
): Promise<AnalysisResult> {
  const modelId = env.AI_ANALYSIS_MODEL;

  try {
    const prompt = buildUserPrompt(tx, contracts);
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

    const { text, usedModel } = await runAIWithRetry(env, messages, modelId);

    // Strip markdown code fences if present
    let jsonText = text.trim();
    const fenceMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      jsonText = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(jsonText);

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
    console.error(JSON.stringify({
      level: "error",
      event: "analysis.failed",
      txHash: tx.txHash,
      error: message,
    }));

    return {
      txHash: tx.txHash,
      summary: `AI analysis failed: ${message}`,
      errorCategory: "analysis:failed",
      likelyCause: "Analysis error",
      suggestedFix: "Review raw transaction data manually",
      detailedAnalysis:
        "The AI analysis request failed before a structured diagnosis could be produced. Use the raw transaction result, diagnostic events, and any contract spec metadata for manual debugging.",
      evidence: [],
      relatedCodes: [],
      debugSteps: [
        "Review the stored transaction envelope and processing metadata manually.",
        "Decode the transaction/result XDR and inspect diagnostic events.",
      ],
      confidence: "failed",
      analyzedAt: new Date().toISOString(),
      modelId,
    };
  }
}
