import type { FailedTransaction, ErrorSignature } from "./types.js";
import {
  extractErrorSignatures,
  extractFunctionName,
} from "./transaction.js";

export { extractErrorSignatures, extractFunctionName };

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
  const functionName = tx.decoded.topLevelFunction || extractFunctionName(tx.envelopeJson);
  const errorSignatures =
    tx.decoded.errorSignatures.length > 0
      ? tx.decoded.errorSignatures
      : extractErrorSignatures(tx.diagnosticEvents);

  // Use primaryContractIds (envelope only) for stable fingerprinting —
  // the full contractIds set includes auth/diag contracts that vary per user
  const parts = [
    tx.primaryContractIds.slice().sort().join(","),
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
    "Stellar/Soroban transaction failure",
    `Result: ${resultKind}`,
    `Contracts: ${contractIds.join(", ") || "none"}`,
    `Function: ${functionName}`,
    `Errors: ${errorSignatures.map((s) => `${s.type}:${s.code}`).join(", ")}`,
  ];
  return parts.join(". ");
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
