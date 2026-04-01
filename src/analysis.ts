import type { Env, FailedTransaction, AnalysisResult } from "./types.js";
// XDR decode available via ./xdr.ts but not needed here — RPC returns JSON via xdrFormat: "json"

const SYSTEM_PROMPT = `You are an expert at analyzing failed Stellar/Soroban smart contract transactions. You will receive comprehensive data about a failed transaction including the function called, its arguments, authorization entries, resource limits, diagnostic events, contract specifications with error code definitions, and transaction results.

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

function buildUserPrompt(
  tx: FailedTransaction,
  contractContext?: string,
): string {
  const parts: string[] = [];

  parts.push(`Transaction Hash: ${tx.txHash}`);
  parts.push(`Result Kind: ${tx.resultKind}`);
  parts.push(`Ledger: ${tx.ledgerSequence} (${tx.ledgerCloseTime})`);
  parts.push(`Operation Types: ${tx.operationTypes.join(", ")}`);
  parts.push(
    `Soroban Operations: ${tx.sorobanOperationTypes.join(", ")}`,
  );
  parts.push(`Primary Contract IDs: ${tx.primaryContractIds.join(", ") || "none"}`);
  const additionalContracts = tx.contractIds.filter(
    (id) => !tx.primaryContractIds.includes(id),
  );
  if (additionalContracts.length > 0) {
    parts.push(`Related Contracts (auth/cross-call): ${additionalContracts.join(", ")}`);
  }

  // Readout summary
  parts.push(`\nReadout:`);
  parts.push(`  Fee Bump: ${tx.readout.feeBump}`);
  parts.push(`  Invoke Call Count: ${tx.readout.invokeCallCount}`);
  parts.push(`  Contract Count: ${tx.readout.contractCount}`);
  if (tx.readout.sourceAccount)
    parts.push(`  Source Account: ${tx.readout.sourceAccount}`);
  if (tx.readout.nonRefundableResourceFeeCharged !== undefined)
    parts.push(
      `  Non-Refundable Fee: ${tx.readout.nonRefundableResourceFeeCharged}`,
    );
  if (tx.readout.refundableResourceFeeCharged !== undefined)
    parts.push(
      `  Refundable Fee: ${tx.readout.refundableResourceFeeCharged}`,
    );
  if (tx.readout.rentFeeCharged !== undefined)
    parts.push(`  Rent Fee: ${tx.readout.rentFeeCharged}`);
  if (tx.readout.returnValue !== undefined)
    parts.push(
      `  Return Value: ${JSON.stringify(tx.readout.returnValue)}`,
    );
  parts.push(
    `  Has Diagnostic Events: ${tx.readout.hasDiagnosticEvents}`,
  );
  if (tx.readout.diagnosticEventCount !== undefined)
    parts.push(
      `  Diagnostic Event Count: ${tx.readout.diagnosticEventCount}`,
    );

  // --- Function calls with arguments ---
  const invokeCalls = extractInvokeCalls(tx.envelopeJson);
  if (invokeCalls.length > 0) {
    parts.push(`\nFunction Calls:`);
    for (const call of invokeCalls) {
      parts.push(`  Contract: ${call.contractId ?? "unknown"}`);
      parts.push(`  Function: ${call.functionName ?? "unknown"}`);
      if (call.args) {
        let argsStr = JSON.stringify(call.args);
        if (argsStr.length > 3000) argsStr = argsStr.slice(0, 3000) + "... [truncated]";
        parts.push(`  Arguments: ${argsStr}`);
      }
    }
  }

  // --- Auth entries (signatures, ledger bounds) ---
  const authEntries = extractAuthEntries(tx.envelopeJson);
  if (authEntries.length > 0) {
    parts.push(`\nAuthorization Entries:`);
    for (const auth of authEntries) {
      let authStr = JSON.stringify(auth);
      if (authStr.length > 2000) authStr = authStr.slice(0, 2000) + "... [truncated]";
      parts.push(`  ${authStr}`);
    }
  }

  // --- Resource limits from envelope ---
  const resources = extractResourceLimits(tx.envelopeJson);
  if (resources) {
    parts.push(`\nResource Limits (from envelope):`);
    if (resources.instructions !== undefined)
      parts.push(`  CPU Instructions: ${resources.instructions}`);
    if (resources.readBytes !== undefined)
      parts.push(`  Read Bytes: ${resources.readBytes}`);
    if (resources.writeBytes !== undefined)
      parts.push(`  Write Bytes: ${resources.writeBytes}`);
    if (resources.extendedMetaDataSizeBytes !== undefined)
      parts.push(`  Extended Meta Size: ${resources.extendedMetaDataSizeBytes}`);
  }

  // --- Transaction result details ---
  const resultDetails = extractResultDetails(tx.processingJson);
  if (resultDetails) {
    parts.push(`\nTransaction Result Details:`);
    let resultStr = JSON.stringify(resultDetails);
    if (resultStr.length > 4000) resultStr = resultStr.slice(0, 4000) + "... [truncated]";
    parts.push(`  ${resultStr}`);
  }

  // --- Contract specifications (high value — placed before verbose events) ---
  if (contractContext) {
    parts.push(contractContext);
  }

  // --- Diagnostic events ---
  if (tx.diagnosticEvents.length > 0) {
    parts.push(`\nDiagnostic Events (${tx.diagnosticEvents.length} total, showing first 15):`);
    const events = tx.diagnosticEvents.slice(0, 15);
    for (let i = 0; i < events.length; i++) {
      let eventStr = JSON.stringify(events[i]);
      if (eventStr.length > 2000) {
        eventStr = eventStr.slice(0, 2000) + "... [truncated]";
      }
      parts.push(`  Event ${i + 1}: ${eventStr}`);
    }
  }

  // --- Contract events (non-diagnostic, least critical) ---
  const contractEvents = extractContractEvents(tx.processingJson);
  if (contractEvents.length > 0) {
    parts.push(`\nContract Events (${contractEvents.length} total, showing first 10):`);
    for (let i = 0; i < Math.min(contractEvents.length, 10); i++) {
      let eventStr = JSON.stringify(contractEvents[i]);
      if (eventStr.length > 1500) eventStr = eventStr.slice(0, 1500) + "... [truncated]";
      parts.push(`  Event ${i + 1}: ${eventStr}`);
    }
  }

  // Guard: keep total prompt under ~60K chars (~15K tokens) to leave room for response
  const MAX_PROMPT_CHARS = 60000;
  let prompt = parts.join("\n");
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
