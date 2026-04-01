/**
 * XDR decode/guess utilities using @stellar/stellar-xdr-json (WASM).
 * Provides rich SEP-51 JSON output from any XDR blob, with type guessing.
 */
import { initSync, decode, guess } from "@stellar/stellar-xdr-json";
// @ts-ignore — Cloudflare Workers can import .wasm files directly
import wasmModule from "@stellar/stellar-xdr-json/stellar_xdr_json_bg.wasm";

let initialized = false;
const PREFERRED_XDR_TYPES = [
  "TransactionEnvelope",
  "TransactionResult",
  "TransactionMeta",
  "LedgerEntryData",
  "LedgerKey",
  "SorobanTransactionData",
  "DiagnosticEvent",
  "ContractEvent",
  "ScVal",
  "ScAddress",
];

function ensureInit() {
  if (!initialized) {
    initSync(wasmModule);
    initialized = true;
  }
}

function normalizeXdrBase64(xdrBase64: string): string {
  return xdrBase64.trim();
}

function orderTypesByPreference(types: string[]): string[] {
  const prioritized = PREFERRED_XDR_TYPES.filter((type) => types.includes(type));
  const remaining = types.filter((type) => !prioritized.includes(type));
  return [...prioritized, ...remaining];
}

/**
 * Guess the XDR type(s) of a base64-encoded XDR blob.
 * Returns an array of possible type names (e.g. ["TransactionEnvelope", "TransactionResult"]).
 */
export function guessXdrType(xdrBase64: string): string[] {
  ensureInit();
  try {
    return guess(normalizeXdrBase64(xdrBase64));
  } catch {
    return [];
  }
}

/**
 * Decode a base64-encoded XDR blob to rich SEP-51 JSON.
 * If type is known, pass it directly. Otherwise, uses guess() to find the type.
 * Returns the parsed JSON object, or null if decoding fails.
 */
export function decodeXdr(
  xdrBase64: string,
  knownType?: string,
): unknown {
  ensureInit();
  const normalized = normalizeXdrBase64(xdrBase64);
  try {
    if (knownType) {
      const jsonStr = decode(knownType, normalized);
      return JSON.parse(jsonStr);
    }

    // Auto-guess the type
    const types = guess(normalized);
    if (types.length === 0) return null;

    for (const type of orderTypesByPreference(types)) {
      try {
        const jsonStr = decode(type, normalized);
        return JSON.parse(jsonStr);
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Decode a base64 XDR blob and return both the type and decoded JSON.
 */
export function decodeXdrWithType(
  xdrBase64: string,
  knownType?: string,
): { type: string; json: unknown } | null {
  ensureInit();
  const normalized = normalizeXdrBase64(xdrBase64);
  try {
    const types = knownType
      ? [knownType]
      : orderTypesByPreference(guess(normalized));
    for (const type of types) {
      try {
        const jsonStr = decode(type, normalized);
        return { type, json: JSON.parse(jsonStr) };
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Walk a JSON object and decode any base64 XDR strings found within it.
 * Replaces XDR strings with { _xdrType, _decoded } objects.
 * Only decodes strings that look like base64 and are > 20 chars.
 * Limits depth to avoid infinite recursion.
 */
export function deepDecodeXdr(
  obj: unknown,
  maxDepth = 3,
): unknown {
  if (maxDepth <= 0) return obj;

  if (typeof obj === "string") {
    const normalized = normalizeXdrBase64(obj);
    // Only try to decode strings that look like base64 XDR (> 20 chars, valid base64)
    if (normalized.length > 20 && /^[A-Za-z0-9+/]+=*$/.test(normalized)) {
      const result = decodeXdrWithType(normalized);
      if (result) {
        return {
          _xdrType: result.type,
          _decoded: result.json,
          _raw: normalized.length > 200 ? normalized.slice(0, 100) + "..." : normalized,
        };
      }
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => deepDecodeXdr(item, maxDepth - 1));
  }

  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      obj as Record<string, unknown>,
    )) {
      result[key] = deepDecodeXdr(value, maxDepth - 1);
    }
    return result;
  }

  return obj;
}
