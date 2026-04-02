import type {
  AnalysisResult,
  ContractMetadata,
  Env,
  FailedTransaction,
} from "./types.js";
import { encode as encodeToon } from "@toon-format/toon";

const SYSTEM_PROMPT = `You are a Stellar/Soroban blockchain error analysis expert. You will receive data about a failed Soroban smart contract transaction on the Stellar network.

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
- The resultKind (transaction-level failure type)
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

function buildUserPrompt(
  tx: FailedTransaction,
  contracts?: Map<string, ContractMetadata>,
): string {
  const aiPayload = compactForAi({
    transaction: {
      txHash: tx.txHash,
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
    raw: {
      envelope: tx.envelopeJson,
      processing: tx.processingJson,
    },
    decoded: {
      envelope: tx.decoded.decodedEnvelope ?? null,
      processing: tx.decoded.decodedProcessing ?? null,
    },
    contracts: summarizeContracts(contracts),
  });

  const toon = encodeToon(aiPayload, { keyFolding: "safe" });

  return [
    "The following document is TOON, a lossless structured encoding of JSON optimized for LLM input.",
    "Interpret it as structured data. Arrays may use [N] lengths and uniform object arrays may use {field,...} headers.",
    "```toon",
    toon,
    "```",
  ].join("\n\n");
}

function summarizeContracts(
  contracts?: Map<string, ContractMetadata>,
): unknown[] {
  if (!contracts || contracts.size === 0) return [];

  return [...contracts.values()].map((meta) => ({
    contractId: meta.contractId,
    wasmHash: meta.wasmHash,
    functions: meta.functions,
    errorEnums: meta.errorEnums,
    structs: meta.structs,
    customSections: meta.customSections,
  }));
}

function compactForAi(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    return value.length > 10000
      ? `${value.slice(0, 10000)}... [truncated]`
      : value;
  }
  if (typeof value !== "object") return value;
  if (depth >= 7) return "[max-depth]";

  if (Array.isArray(value)) {
    const limit = depth <= 1 ? 50 : 30;
    const items = value
      .slice(0, limit)
      .map((item) => compactForAi(item, depth + 1));
    if (value.length > limit) {
      items.push({
        _truncated: true,
        remainingItems: value.length - limit,
      });
    }
    return items;
  }

  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    output[key] = compactForAi(inner, depth + 1);
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
          max_completion_tokens: 4096,
        });

        let text: string | null = null;
        if (typeof response === "string") {
          text = response;
        } else if (response?.response) {
          text = response.response;
        } else if (response?.choices?.[0]?.message?.content) {
          text = response.choices[0].message.content;
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
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(tx, contracts) },
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
