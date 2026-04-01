import type { FailedTransaction, ErrorSignature } from "./types.js";

// --- Error signature extraction ---

/** Walk a value tree and collect all `error` objects from diagnostic events */
function collectErrors(value: unknown): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  if (Array.isArray(value)) {
    for (const item of value) results.push(...collectErrors(item));
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("error" in obj && obj.error !== null && obj.error !== undefined) {
      results.push(obj.error as Record<string, unknown>);
    }
    for (const v of Object.values(obj)) results.push(...collectErrors(v));
  }
  return results;
}

/** Walk a value tree and collect all `function_name` strings from the envelope */
function collectFunctionNames(value: unknown): string[] {
  const results: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) results.push(...collectFunctionNames(item));
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (
      "function_name" in obj &&
      typeof obj.function_name === "string"
    ) {
      results.push(obj.function_name);
    }
    for (const v of Object.values(obj)) {
      results.push(...collectFunctionNames(v));
    }
  }
  return results;
}

/**
 * Extract unique error signatures from diagnostic events.
 *
 * Diagnostic error objects look like:
 *   { auth: "invalid_input" }
 *   { contract: 8 }
 *   { wasm: "unreachable" }
 *
 * We normalize these into { type, code } pairs and deduplicate.
 */
export function extractErrorSignatures(
  diagnosticEvents: unknown[],
): ErrorSignature[] {
  const errors = collectErrors(diagnosticEvents);
  const seen = new Set<string>();
  const signatures: ErrorSignature[] = [];

  for (const err of errors) {
    for (const [type, code] of Object.entries(err)) {
      const sig: ErrorSignature = { type, code: String(code) };
      const key = `${sig.type}:${sig.code}`;
      if (!seen.has(key)) {
        seen.add(key);
        signatures.push(sig);
      }
    }
  }

  return signatures.sort((a, b) =>
    `${a.type}:${a.code}`.localeCompare(`${b.type}:${b.code}`),
  );
}

/**
 * Extract the primary invoked function name from the envelope.
 * Falls back to "unknown" if not found.
 */
export function extractFunctionName(envelopeJson: unknown): string {
  const names = collectFunctionNames(envelopeJson);
  // The first function_name in the envelope is the top-level invoked function
  return names[0] ?? "unknown";
}

// --- Fingerprint construction ---

/**
 * Build a deterministic fingerprint string from the error's structural identity.
 * SHA-256 hex hash of: contractIds | functionName | errorSignatures | resultKind
 */
export async function buildFingerprint(
  tx: FailedTransaction,
): Promise<{
  fingerprint: string;
  functionName: string;
  errorSignatures: ErrorSignature[];
}> {
  const functionName = extractFunctionName(tx.envelopeJson);
  const errorSignatures = extractErrorSignatures(tx.diagnosticEvents);

  const parts = [
    tx.contractIds.slice().sort().join(","),
    functionName,
    errorSignatures.map((s) => `${s.type}:${s.code}`).join(","),
    tx.resultKind,
  ];

  const input = parts.join("|");
  const hash = await sha256(input);

  return { fingerprint: hash, functionName, errorSignatures };
}

/**
 * Build a human-readable description of the error for embedding.
 * Used for vector similarity search.
 */
export function buildErrorDescription(
  contractIds: string[],
  functionName: string,
  errorSignatures: ErrorSignature[],
  resultKind: string,
): string {
  const parts = [
    `Stellar/Soroban transaction failure`,
    `Result: ${resultKind}`,
    `Contracts: ${contractIds.join(", ") || "none"}`,
    `Function: ${functionName}`,
    `Errors: ${errorSignatures.map((s) => `${s.type}:${s.code}`).join(", ")}`,
  ];
  return parts.join(". ");
}

// --- Utilities ---

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
