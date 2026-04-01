import { encode } from "@toon-format/toon";
import type { Env, FailedTransaction, AnalysisResult } from "./types.js";
import type { ContractMetadata } from "./contracts.js";
import {
  formatScVal,
  formatInvokeCall,
  formatAuthEntry,
  buildCallStack,
  renderCallStack,
  extractStateChanges,
} from "./format.js";

const SYSTEM_PROMPT = `You are a Stellar/Soroban blockchain error analysis expert. You will receive data about a failed Soroban smart contract transaction on the Stellar network.

The transaction data is provided in TOON format (compact structured notation with 2-space indentation, arrays show length and field names). The execution trace uses indented arrows: -> for calls, <- for returns, !! for errors.

Analyze the failure and respond with a JSON object containing exactly these fields:
- "summary": A concise 1-2 sentence description of what went wrong
- "errorCategory": One of: "ContractTrapped", "InsufficientBalance", "AuthorizationFailed", "ResourceExhaustion", "InvalidArguments", "ContractNotFound", "SequenceError", "TimeBoundsExceeded", "InternalError", "Other"
- "likelyCause": The most probable root cause of the failure
- "suggestedFix": A concrete next debugging step or fix suggestion
- "confidence": "high", "medium", or "low" based on how much diagnostic info was available

Analyze ALL available data:
- The resultKind (transaction-level failure type)
- The sorobanError opResult code (e.g. invoke_host_function_trapped) — this is the most authoritative failure indicator
- The execution trace: follow the call chain (-> arrows), identify where the error (!! markers) occurred, and check return values (<- arrows) for Error(...) patterns
- Return value: for failed calls, this often contains the exact contract error code (e.g. Error(contract: 8))
- Function calls and their arguments — check if arguments are invalid (zero amounts, wrong types, out of range values)
- Authorization entries: check signature expiration ledger vs actual ledger, credential types, and cross-contract call auth
- Resource limits: compare CPU instructions and read/write bytes from envelope against what was consumed
- State changes: what ledger entries were read/created/updated — helps identify missing or expired data
- Contract specifications (if provided): map numeric error codes to their named variants and doc comments, check function signatures for expected parameter types`;

function buildUserPrompt(
  tx: FailedTransaction,
  contractContext?: string,
): string {
  // --- Build structured data object for TOON encoding ---
  const data: Record<string, unknown> = {
    txHash: tx.txHash,
    resultKind: tx.resultKind,
    ledger: tx.ledgerSequence,
    ledgerCloseTime: tx.ledgerCloseTime,
    operationTypes: tx.operationTypes,
    sorobanOperations: tx.sorobanOperationTypes,
    contractIds: tx.contractIds.length > 0 ? tx.contractIds : "none",
  };

  // --- Soroban-specific error (most authoritative) ---
  const sorobanError = extractSorobanResultError(tx.processingJson);
  if (sorobanError) {
    data.sorobanError = {
      opResult: sorobanError.opResult,
      ...(sorobanError.hostFunction ? { detail: sorobanError.hostFunction } : {}),
    };
  }

  // --- Return value (often contains contract error code) ---
  if (tx.readout.returnValue !== undefined && tx.readout.returnValue !== null) {
    data.returnValue = formatScVal(tx.readout.returnValue);
  }

  // --- Readout summary ---
  const readout: Record<string, unknown> = {
    feeBump: tx.readout.feeBump,
    invokeCallCount: tx.readout.invokeCallCount,
    contractCount: tx.readout.contractCount,
  };
  if (tx.readout.sourceAccount) readout.sourceAccount = tx.readout.sourceAccount;
  if (tx.readout.feeSourceAccount) readout.feeSourceAccount = tx.readout.feeSourceAccount;
  if (tx.readout.nonRefundableResourceFeeCharged !== undefined)
    readout.nonRefundableResourceFee = tx.readout.nonRefundableResourceFeeCharged;
  if (tx.readout.refundableResourceFeeCharged !== undefined)
    readout.refundableResourceFee = tx.readout.refundableResourceFeeCharged;
  if (tx.readout.rentFeeCharged !== undefined)
    readout.rentFee = tx.readout.rentFeeCharged;
  data.readout = readout;

  // --- Function calls with ScVal-formatted arguments ---
  const invokeCalls = extractInvokeCalls(tx.envelopeJson);
  if (invokeCalls.length > 0) {
    data.functionCalls = invokeCalls.map((ic) =>
      formatInvokeCall(ic as Record<string, unknown>),
    );
  }

  // --- Auth entries (structured) ---
  const authEntries = extractAuthEntries(tx.envelopeJson);
  if (authEntries.length > 0) {
    data.authEntries = authEntries.map((auth) =>
      formatAuthEntry(auth as Record<string, unknown>),
    );
  }

  // --- Resource limits from envelope ---
  const resources = extractResourceLimits(tx.envelopeJson);
  if (resources) {
    data.resourceLimits = resources;
  }

  // --- State changes from result meta ---
  const stateChanges = extractStateChanges(tx.processingJson);
  if (stateChanges.length > 0) {
    data.stateChanges = stateChanges.slice(0, 20).map((sc) => sc.summary);
  }

  // --- Encode structured data as TOON ---
  let toonData: string;
  try {
    toonData = encode(data, { keyFolding: "safe" });
  } catch {
    // Fallback to JSON if TOON encoding fails (e.g. circular refs)
    toonData = JSON.stringify(data, null, 2);
  }

  const parts: string[] = [];

  parts.push("```toon");
  parts.push(toonData);
  parts.push("```");

  // --- Execution trace (call stack from diagnostic events) ---
  if (tx.diagnosticEvents.length > 0) {
    const callStack = buildCallStack(tx.diagnosticEvents);
    const trace = renderCallStack(callStack);
    if (trace) {
      parts.push("");
      parts.push(`Execution Trace (${tx.diagnosticEvents.length} diagnostic events):`);
      parts.push("```");
      parts.push(trace);
      parts.push("```");
    }
  }

  // --- Transaction result details (compact) ---
  const resultDetails = extractResultDetails(tx.processingJson);
  if (resultDetails) {
    let resultStr = JSON.stringify(resultDetails);
    if (resultStr.length > 3000) resultStr = resultStr.slice(0, 3000) + "...";
    parts.push("");
    parts.push(`Transaction Result: ${resultStr}`);
  }

  // --- Contract events (non-diagnostic) ---
  const contractEvents = extractContractEvents(tx.processingJson);
  if (contractEvents.length > 0) {
    const formatted = contractEvents.slice(0, 8).map((evt) => {
      let s = JSON.stringify(evt);
      if (s.length > 500) s = s.slice(0, 500) + "...";
      return s;
    });
    parts.push("");
    parts.push(`Contract Events (${contractEvents.length} total):`);
    for (const f of formatted) {
      parts.push(`  ${f}`);
    }
  }

  // --- Contract specifications ---
  if (contractContext) {
    parts.push("");
    parts.push(contractContext);
  }

  return parts.join("\n");
}

// --- Envelope data extraction helpers ---

function extractInvokeCalls(envelope: unknown): any[] {
  const calls: any[] = [];
  walkJson(envelope, (key, value) => {
    if (key === "invoke_contract" && value && typeof value === "object") {
      calls.push(value);
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
  return entries.slice(0, 5);
}

function extractResourceLimits(envelope: unknown): Record<string, number> | null {
  let resources: Record<string, number> | null = null;
  walkJson(envelope, (key, value) => {
    if (key === "resources" && value && typeof value === "object") {
      const r = value as Record<string, unknown>;
      if ("instructions" in r || "read_bytes" in r) {
        resources = {};
        if (r.instructions !== undefined)
          resources.cpuInstructions = Number(r.instructions);
        if (r.read_bytes !== undefined)
          resources.readBytes = Number(r.read_bytes);
        if (r.write_bytes !== undefined)
          resources.writeBytes = Number(r.write_bytes);
        if (r.extended_meta_data_size_bytes !== undefined)
          resources.extendedMetaSize = Number(r.extended_meta_data_size_bytes);
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

/**
 * Extract Soroban-specific error codes from the transaction result.
 * The result path is: result.result.tx_failed[].op_inner.invoke_host_function_*
 */
function extractSorobanResultError(processing: unknown): {
  opResult: string;
  hostFunction?: string;
} | null {
  if (!processing || typeof processing !== "object") return null;
  const result = (processing as any)?.result?.result;
  if (!result) return null;

  const txFailed = result.tx_failed ?? result.tx_fee_bump_inner_failed;
  if (!Array.isArray(txFailed)) return null;

  for (const opResult of txFailed) {
    if (!opResult || typeof opResult !== "object") continue;
    const opInner = opResult.op_inner;
    if (!opInner || typeof opInner !== "object") continue;

    for (const [key, value] of Object.entries(opInner as Record<string, unknown>)) {
      if (
        key.startsWith("invoke_host_function") ||
        key.startsWith("restore_footprint") ||
        key.startsWith("extend_footprint_ttl")
      ) {
        return {
          opResult: key,
          hostFunction: typeof value === "string" ? value : JSON.stringify(value),
        };
      }
    }
  }

  return null;
}

function extractContractEvents(processing: unknown): any[] {
  if (!processing || typeof processing !== "object") return [];
  const events: any[] = [];
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
            break;
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
  contractContext?: string,
): Promise<AnalysisResult> {
  const modelId = env.AI_MODEL;

  try {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(tx, contractContext) },
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
