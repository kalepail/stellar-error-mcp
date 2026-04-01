import { encode } from "@toon-format/toon";
import type { Env, FailedTransaction, AnalysisResult } from "./types.js";
import type { ContractMetadata } from "./contracts.js";

const SYSTEM_PROMPT = `You are an expert at analyzing failed Stellar/Soroban smart contract transactions. You will receive comprehensive data about a failed transaction including the function called, its arguments, authorization entries, resource limits, diagnostic events, contract specifications with error code definitions, and transaction results.

The data is provided in TOON (Token-Oriented Object Notation) format — a compact encoding of JSON. Key-value pairs use "key: value", arrays use "key[N]:" headers, and tabular arrays use "key[N]{col1,col2}:" with CSV-style rows.

Your job is to determine exactly what went wrong and provide actionable guidance. Respond with a JSON object containing exactly these fields:

- "summary": 1-2 sentences describing what failed and why. Be specific — name the function, the error code and its meaning, and what triggered it. Avoid vague language.
- "errorCategory": One of: "ContractTrapped", "InsufficientBalance", "AuthorizationFailed", "ResourceExhaustion", "InvalidArguments", "ContractNotFound", "SequenceError", "TimeBoundsExceeded", "InternalError", "Other"
- "likelyCause": The most probable root cause. Reference specific values from the data — e.g. "amount was 0 but plant() requires > 0", "signature expired at ledger 61922247 but tx landed at 61922248", "CPU instructions budget 500000 was insufficient".
- "suggestedFix": A concrete, actionable fix. Not "check the parameters" but "pass a non-zero i128 value for the amount parameter" or "increase valid_until_ledger by at least 10 ledgers to account for network latency".
- "confidence": "high" if error codes and contract spec clearly explain the failure, "medium" if some inference needed, "low" if diagnostic data is sparse.

Analysis priorities:
1. Contract error codes + error enum definitions → map code numbers to named errors (e.g. error 8 = PailExists)
2. Function signature + arguments → check if inputs violate contract constraints
3. Authorization entries → check signature ledger bounds and credential validity
4. Diagnostic event trace → follow the execution path to the failure point
5. Resource limits vs consumed → identify resource exhaustion
6. Transaction result details → precise failure code path`;

function truncateJson(value: unknown, maxChars: number): string {
  const str = JSON.stringify(value);
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + "...[truncated]";
}

function buildUserPrompt(
  tx: FailedTransaction,
  contracts?: Map<string, ContractMetadata>,
): string {
  const additionalContracts = tx.contractIds.filter(
    (id) => !tx.primaryContractIds.includes(id),
  );

  // Build structured prompt data — TOON encodes this compactly
  const promptData: Record<string, unknown> = {};

  // --- Transaction identity ---
  promptData.transaction = {
    hash: tx.txHash,
    resultKind: tx.resultKind,
    ledger: tx.ledgerSequence,
    ledgerCloseTime: tx.ledgerCloseTime,
    operationTypes: tx.operationTypes,
    sorobanOperations: tx.sorobanOperationTypes,
    primaryContracts: tx.primaryContractIds.length > 0
      ? tx.primaryContractIds
      : ["none"],
    ...(additionalContracts.length > 0 && {
      relatedContracts: additionalContracts,
    }),
  };

  // --- Readout summary ---
  const readout: Record<string, unknown> = {
    feeBump: tx.readout.feeBump,
    invokeCallCount: tx.readout.invokeCallCount,
    contractCount: tx.readout.contractCount,
    hasDiagnosticEvents: tx.readout.hasDiagnosticEvents,
  };
  if (tx.readout.sourceAccount) readout.sourceAccount = tx.readout.sourceAccount;
  if (tx.readout.nonRefundableResourceFeeCharged !== undefined)
    readout.nonRefundableFee = tx.readout.nonRefundableResourceFeeCharged;
  if (tx.readout.refundableResourceFeeCharged !== undefined)
    readout.refundableFee = tx.readout.refundableResourceFeeCharged;
  if (tx.readout.rentFeeCharged !== undefined)
    readout.rentFee = tx.readout.rentFeeCharged;
  if (tx.readout.returnValue !== undefined)
    readout.returnValue = truncateJson(tx.readout.returnValue, 500);
  if (tx.readout.diagnosticEventCount !== undefined)
    readout.diagnosticEventCount = tx.readout.diagnosticEventCount;
  promptData.readout = readout;

  // --- Function calls with arguments ---
  const invokeCalls = extractInvokeCalls(tx.envelopeJson);
  if (invokeCalls.length > 0) {
    promptData.functionCalls = invokeCalls.map((call) => ({
      contract: call.contractId ?? "unknown",
      function: call.functionName ?? "unknown",
      ...(call.args && { arguments: truncateJson(call.args, 3000) }),
    }));
  }

  // --- Auth entries (pre-truncated as JSON strings) ---
  const authEntries = extractAuthEntries(tx.envelopeJson);
  if (authEntries.length > 0) {
    promptData.authorizationEntries = authEntries.map(
      (auth) => truncateJson(auth, 2000),
    );
  }

  // --- Resource limits from envelope ---
  const resources = extractResourceLimits(tx.envelopeJson);
  if (resources) {
    promptData.resourceLimits = resources;
  }

  // --- Transaction result details ---
  const resultDetails = extractResultDetails(tx.processingJson);
  if (resultDetails) {
    promptData.resultDetails = truncateJson(resultDetails, 4000);
  }

  // --- Contract specifications (high value — TOON tabular format shines here) ---
  if (contracts && contracts.size > 0) {
    const specs: Record<string, unknown> = {};
    for (const [id, meta] of contracts) {
      const spec: Record<string, unknown> = {
        wasmHash: meta.wasmHash,
      };
      if (meta.errorEnums.length > 0) {
        // Tabular: errorCodes[N]{value,name}: rows
        spec.errorCodes = meta.errorEnums.flatMap((e) =>
          e.cases.map((c) => ({ value: c.value, name: c.name })),
        );
      }
      if (meta.functions.length > 0) {
        // Tabular: functions[N]{name,inputs,outputs}: rows
        spec.functions = meta.functions.map((fn) => ({
          name: fn.name,
          inputs: fn.inputs.map((i) => `${i.name}: ${i.type}`).join(", "),
          outputs: fn.outputs.join(", ") || "void",
        }));
      }
      if (meta.structs.length > 0) {
        spec.types = meta.structs.map((s) => ({
          name: s.name,
          fields: s.fields.map((f) => `${f.name}: ${f.type}`).join(", "),
        }));
      }
      specs[id] = spec;
    }
    promptData.contractSpecifications = specs;
  }

  // --- Diagnostic events (pre-truncated as JSON strings, least critical) ---
  if (tx.diagnosticEvents.length > 0) {
    promptData.diagnosticEvents = tx.diagnosticEvents
      .slice(0, 15)
      .map((event) => truncateJson(event, 2000));
  }

  // --- Contract events (non-diagnostic, least critical) ---
  const contractEvents = extractContractEvents(tx.processingJson);
  if (contractEvents.length > 0) {
    promptData.contractEvents = contractEvents
      .slice(0, 10)
      .map((event) => truncateJson(event, 1500));
  }

  // Encode the entire prompt as TOON
  const MAX_PROMPT_CHARS = 60000;
  let prompt = encode(promptData);
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + "\n\n[... prompt truncated for length]";
  }
  return prompt;
}

// --- Envelope data extraction helpers ---

function extractInvokeCalls(envelope: unknown): any[] {
  const calls: any[] = [];
  walkJson(envelope, (key, value, parent) => {
    if (key === "invoke_contract" && value && typeof value === "object") {
      const ic = value as Record<string, unknown>;
      calls.push({
        contractId: ic.contract_address,
        functionName: ic.function_name,
        args: ic.args,
      });
    }
  });
  return calls;
}

function extractAuthEntries(envelope: unknown): any[] {
  const entries: any[] = [];
  walkJson(envelope, (key, value) => {
    if (key === "soroban_credentials" && value && typeof value === "object") {
      entries.push(value);
    }
  });
  return entries.slice(0, 5); // cap to avoid bloat
}

function extractResourceLimits(envelope: unknown): {
  instructions?: number;
  readBytes?: number;
  writeBytes?: number;
  extendedMetaDataSizeBytes?: number;
} | null {
  let resources: any = null;
  walkJson(envelope, (key, value) => {
    if (key === "resources" && value && typeof value === "object") {
      const r = value as Record<string, unknown>;
      if ("instructions" in r || "read_bytes" in r) {
        resources = {
          instructions: r.instructions,
          readBytes: r.read_bytes,
          writeBytes: r.write_bytes,
          extendedMetaDataSizeBytes: r.extended_meta_data_size_bytes,
        };
      }
    }
  });
  return resources;
}

function extractResultDetails(processing: unknown): unknown {
  if (!processing || typeof processing !== "object") return null;
  const p = processing as Record<string, unknown>;
  return p.result ?? null;
}

function extractContractEvents(processing: unknown): any[] {
  if (!processing || typeof processing !== "object") return [];
  const events: any[] = [];
  // Path: tx_apply_processing.v4.events
  const v4 = (processing as any)?.tx_apply_processing?.v4;
  if (v4?.events && Array.isArray(v4.events)) {
    events.push(...v4.events);
  }
  return events;
}

function walkJson(
  obj: unknown,
  callback: (key: string, value: unknown, parent: unknown) => void,
): void {
  if (Array.isArray(obj)) {
    for (const item of obj) walkJson(item, callback);
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      callback(k, v, obj);
      walkJson(v, callback);
    }
  }
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
            console.log(
              `Model ${model} failed after ${attempt + 1} attempts, trying fallback...`,
            );
            break; // try next model
          }
          throw error;
        }

        const delay = RETRY_DELAYS[attempt] ?? 5000;
        console.log(
          `AI call attempt ${attempt + 1} failed (${model}), retrying in ${delay}ms...`,
        );
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
  const modelId = env.AI_MODEL;

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
      summary: parsed.summary ?? "Analysis could not produce a summary",
      errorCategory: parsed.errorCategory ?? "Other",
      likelyCause: parsed.likelyCause ?? "Unknown",
      suggestedFix: parsed.suggestedFix ?? "Review diagnostic events manually",
      confidence: parsed.confidence ?? "low",
      analyzedAt: new Date().toISOString(),
      modelId: usedModel,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`AI analysis failed for ${tx.txHash}: ${message}`);

    return {
      txHash: tx.txHash,
      summary: `AI analysis failed: ${message}`,
      errorCategory: "Other",
      likelyCause: "Analysis error",
      suggestedFix: "Review raw transaction data manually",
      confidence: "failed",
      analyzedAt: new Date().toISOString(),
      modelId,
    };
  }
}
