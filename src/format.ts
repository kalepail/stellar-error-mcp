/**
 * Formatting utilities for Stellar/Soroban data.
 * Converts raw XDR JSON (SEP-51 format) into human-readable, AI-friendly output.
 *
 * Inspired by Stellar Laboratory's formatDiagnosticEvents.ts and ScValPrettyJson.
 */

// --- ScVal Formatting ---

/**
 * Format an ScVal JSON object (SEP-51 format) into a human-readable string.
 * ScVals are unions keyed by type: { "i128": { "hi": 0, "lo": 1000000 } }
 */
export function formatScVal(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "string") return val;
  if (typeof val !== "object") return String(val);

  const obj = val as Record<string, unknown>;

  if ("bool" in obj) return String(obj.bool);
  if ("void" in obj) return "void";

  // Error variant — extract type and code
  if ("error" in obj) {
    const err = obj.error as Record<string, unknown> | undefined;
    if (err && typeof err === "object") {
      const entries = Object.entries(err);
      if (entries.length > 0) {
        return `Error(${entries.map(([k, v]) => `${k}: ${v}`).join(", ")})`;
      }
    }
    return `Error(${formatScVal(obj.error)})`;
  }

  // Integer types
  if ("u32" in obj) return String(obj.u32);
  if ("i32" in obj) return String(obj.i32);
  if ("u64" in obj) return String(obj.u64);
  if ("i64" in obj) return String(obj.i64);

  // 128-bit: { hi: number, lo: number }
  if ("i128" in obj) return formatI128(obj.i128);
  if ("u128" in obj) return formatU128(obj.u128);

  // 256-bit: { hi_hi, hi_lo, lo_hi, lo_lo }
  if ("i256" in obj) return formatI256(obj.i256);
  if ("u256" in obj) return formatU256(obj.u256);

  // String-like
  if ("symbol" in obj) return String(obj.symbol);
  if ("string" in obj) return `"${obj.string}"`;
  if ("bytes" in obj) {
    const b = String(obj.bytes);
    return b.length > 40 ? `bytes(${b.slice(0, 40)}...)` : `bytes(${b})`;
  }

  // Address (already a C.../G... string in SEP-51 JSON)
  if ("address" in obj) return String(obj.address);

  // Timepoint/Duration
  if ("timepoint" in obj) return `timepoint(${obj.timepoint})`;
  if ("duration" in obj) return `duration(${obj.duration})`;

  // Container: Vec
  if ("vec" in obj) {
    const items = Array.isArray(obj.vec) ? obj.vec : [];
    if (items.length > 10) {
      return `[${items.slice(0, 10).map(formatScVal).join(", ")}, ... +${items.length - 10} more]`;
    }
    return `[${items.map(formatScVal).join(", ")}]`;
  }

  // Container: Map
  if ("map" in obj) {
    const entries = Array.isArray(obj.map) ? obj.map : [];
    const formatted = entries.slice(0, 10).map((entry: any) => {
      const k = formatScVal(entry?.key);
      const v = formatScVal(entry?.val);
      return `${k}: ${v}`;
    });
    const suffix = entries.length > 10 ? `, ... +${entries.length - 10} more` : "";
    return `{${formatted.join(", ")}${suffix}}`;
  }

  // Contract instance
  if ("contract_instance" in obj) return "ContractInstance";

  // Ledger key nonce
  if ("ledger_key_nonce" in obj) return `nonce(${JSON.stringify(obj.ledger_key_nonce)})`;

  // Fallback: single-key union
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    return `${keys[0]}(${formatScVal(obj[keys[0]])})`;
  }

  // Last resort — compact JSON
  const s = JSON.stringify(val);
  return s.length > 200 ? s.slice(0, 200) + "..." : s;
}

function formatU128(val: unknown): string {
  if (val === null || val === undefined) return "0";
  if (typeof val === "number" || typeof val === "string") return String(val);
  if (typeof val !== "object") return String(val);
  const obj = val as Record<string, any>;
  try {
    const hi = BigInt(obj.hi ?? 0);
    const lo = BigInt(obj.lo ?? 0);
    return ((hi << 64n) | (lo & ((1n << 64n) - 1n))).toString();
  } catch {
    return JSON.stringify(val);
  }
}

function formatI128(val: unknown): string {
  if (val === null || val === undefined) return "0";
  if (typeof val === "number" || typeof val === "string") return String(val);
  if (typeof val !== "object") return String(val);
  const obj = val as Record<string, any>;
  try {
    const hi = BigInt(obj.hi ?? 0);
    const lo = BigInt(obj.lo ?? 0);
    const unsigned = ((hi & ((1n << 64n) - 1n)) << 64n) | (lo & ((1n << 64n) - 1n));
    // Check sign bit
    if (hi < 0n || (hi >> 63n) & 1n) {
      return (unsigned - (1n << 128n)).toString();
    }
    return unsigned.toString();
  } catch {
    return JSON.stringify(val);
  }
}

function formatU256(val: unknown): string {
  if (val === null || val === undefined) return "0";
  if (typeof val === "number" || typeof val === "string") return String(val);
  if (typeof val !== "object") return String(val);
  const obj = val as Record<string, any>;
  try {
    const hiHi = BigInt(obj.hi_hi ?? 0);
    const hiLo = BigInt(obj.hi_lo ?? 0);
    const loHi = BigInt(obj.lo_hi ?? 0);
    const loLo = BigInt(obj.lo_lo ?? 0);
    const mask64 = (1n << 64n) - 1n;
    return (
      ((hiHi & mask64) << 192n) |
      ((hiLo & mask64) << 128n) |
      ((loHi & mask64) << 64n) |
      (loLo & mask64)
    ).toString();
  } catch {
    return JSON.stringify(val);
  }
}

function formatI256(val: unknown): string {
  if (val === null || val === undefined) return "0";
  if (typeof val === "number" || typeof val === "string") return String(val);
  if (typeof val !== "object") return String(val);
  const obj = val as Record<string, any>;
  try {
    const hiHi = BigInt(obj.hi_hi ?? 0);
    const hiLo = BigInt(obj.hi_lo ?? 0);
    const loHi = BigInt(obj.lo_hi ?? 0);
    const loLo = BigInt(obj.lo_lo ?? 0);
    const mask64 = (1n << 64n) - 1n;
    const unsigned =
      ((hiHi & mask64) << 192n) |
      ((hiLo & mask64) << 128n) |
      ((loHi & mask64) << 64n) |
      (loLo & mask64);
    // Check sign bit (top bit of hi_hi)
    if ((hiHi >> 63n) & 1n) {
      return (unsigned - (1n << 256n)).toString();
    }
    return unsigned.toString();
  } catch {
    return JSON.stringify(val);
  }
}

// --- Extract symbol/string from an ScVal ---

function extractSymbol(val: unknown): string {
  if (typeof val === "string") return val;
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if ("symbol" in obj) return String(obj.symbol);
    if ("string" in obj) return String(obj.string);
  }
  return formatScVal(val);
}

// --- Diagnostic Event Call Stack ---

/**
 * A processed entry from the diagnostic event stream.
 * Modeled after Stellar Laboratory's formatDiagnosticEvents.
 */
export interface CallStackEntry {
  type: "fn_call" | "fn_return" | "error" | "event" | "log";
  contractId?: string;
  functionName?: string;
  args?: string[];
  returnValue?: string;
  errorMessage?: string;
  depth: number;
  inSuccessfulCall: boolean;
}

/**
 * Process raw diagnostic events into a structured call stack.
 *
 * Diagnostic events follow a pattern:
 *   fn_call → (nested fn_calls) → fn_return
 *   error events indicate where execution failed
 *
 * This mirrors Stellar Laboratory's formatDiagnosticEvents.ts logic.
 */
export function buildCallStack(events: unknown[]): CallStackEntry[] {
  const entries: CallStackEntry[] = [];
  let depth = 0;

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const evt = event as Record<string, unknown>;

    const inSuccess = evt.in_successful_contract_call === true;
    const contractId = (evt.contract_id ?? evt.contractId) as string | undefined;

    // Body can be { v0: { topics, data } } or flat { topics, data }
    const body = evt.body as Record<string, unknown> | undefined;
    if (!body) continue;

    const v0 = body.v0 as Record<string, unknown> | undefined;
    const topics: unknown[] = (v0?.topics ?? body.topics) as unknown[] ?? [];
    const data: unknown = v0?.data ?? body.data;

    if (topics.length === 0) continue;

    const topicSym = extractSymbol(topics[0]);

    switch (topicSym) {
      case "fn_call": {
        const fnName = topics.length > 1 ? extractSymbol(topics[1]) : "unknown";
        const args = formatCallArgs(data);
        entries.push({
          type: "fn_call",
          contractId: contractId ?? undefined,
          functionName: fnName,
          args,
          depth,
          inSuccessfulCall: inSuccess,
        });
        depth++;
        break;
      }

      case "fn_return": {
        depth = Math.max(0, depth - 1);
        const fnName = topics.length > 1 ? extractSymbol(topics[1]) : "unknown";
        entries.push({
          type: "fn_return",
          contractId: contractId ?? undefined,
          functionName: fnName,
          returnValue: data !== undefined ? formatScVal(data) : undefined,
          depth,
          inSuccessfulCall: inSuccess,
        });
        break;
      }

      case "error": {
        entries.push({
          type: "error",
          contractId: contractId ?? undefined,
          errorMessage: data !== undefined ? formatScVal(data) : "unknown error",
          depth,
          inSuccessfulCall: inSuccess,
        });
        break;
      }

      case "log":
      case "host_fn_failed": {
        entries.push({
          type: "log",
          contractId: contractId ?? undefined,
          errorMessage: data !== undefined ? formatScVal(data) : topicSym,
          depth,
          inSuccessfulCall: inSuccess,
        });
        break;
      }

      default: {
        // Contract-emitted event
        entries.push({
          type: "event",
          contractId: contractId ?? undefined,
          functionName: topics.map(extractSymbol).join("."),
          args: data ? [formatScVal(data)] : undefined,
          depth,
          inSuccessfulCall: inSuccess,
        });
        break;
      }
    }
  }

  return entries;
}

function formatCallArgs(data: unknown): string[] {
  if (data === undefined || data === null) return [];
  if (typeof data === "object" && "vec" in (data as any)) {
    const vec = (data as any).vec;
    if (Array.isArray(vec)) return vec.map(formatScVal);
  }
  return [formatScVal(data)];
}

/**
 * Render a call stack as an indented execution trace.
 * Uses arrows for calls/returns and markers for errors.
 *
 * Example output:
 *   → CABC...XYZ::transfer(GABC..., GDEF..., 1000000)
 *     → CDEF...ABC::check_balance(GABC...)
 *     ← check_balance = 500
 *     ✗ ERROR: Error(contract: 10)
 *   ← transfer = Error(contract: 10) [FAILED]
 */
export function renderCallStack(entries: CallStackEntry[]): string {
  if (entries.length === 0) return "";

  const lines: string[] = [];
  for (const entry of entries) {
    const indent = "  ".repeat(entry.depth);
    const failed = entry.inSuccessfulCall ? "" : " [FAILED]";

    switch (entry.type) {
      case "fn_call": {
        const contract = entry.contractId
          ? shortenId(entry.contractId)
          : "?";
        const args = entry.args?.join(", ") ?? "";
        lines.push(
          `${indent}-> ${contract}::${entry.functionName}(${args})${failed}`,
        );
        break;
      }
      case "fn_return": {
        const rv = entry.returnValue ?? "void";
        lines.push(`${indent}<- ${entry.functionName} = ${rv}${failed}`);
        break;
      }
      case "error": {
        lines.push(`${indent}!! ERROR: ${entry.errorMessage}${failed}`);
        break;
      }
      case "log": {
        lines.push(`${indent}   log: ${entry.errorMessage}`);
        break;
      }
      case "event": {
        const data = entry.args?.[0] ?? "";
        lines.push(
          `${indent}   event(${entry.functionName}): ${data}`,
        );
        break;
      }
    }
  }
  return lines.join("\n");
}

function shortenId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}..${id.slice(-4)}`;
}

// --- State Change Extraction ---

/**
 * Extract ledger state changes from transaction processing meta.
 * Shows what contract data/code entries were read, created, updated, or removed.
 */
export function extractStateChanges(processingJson: unknown): StateChange[] {
  if (!processingJson || typeof processingJson !== "object") return [];

  const v4 = (processingJson as any)?.tx_apply_processing?.v4;
  if (!v4?.operations || !Array.isArray(v4.operations)) return [];

  const changes: StateChange[] = [];

  for (const op of v4.operations) {
    if (!op?.changes || !Array.isArray(op.changes)) continue;

    for (const change of op.changes) {
      if (!change || typeof change !== "object") continue;

      const keys = Object.keys(change);
      if (keys.length === 0) continue;

      const changeType = keys[0]; // "created", "updated", "removed", "state"
      const entry = change[changeType];
      if (!entry) continue;

      const parsed = parseStateChangeEntry(changeType, entry);
      if (parsed) changes.push(parsed);
    }
  }

  return changes;
}

export interface StateChange {
  action: string; // created, updated, removed
  entryType: string; // contract_data, contract_code, account, trustline, etc.
  contractId?: string;
  key?: string;
  summary: string;
}

function parseStateChangeEntry(
  action: string,
  entry: unknown,
): StateChange | null {
  if (!entry || typeof entry !== "object") return null;

  const data = (entry as any)?.data;
  if (!data || typeof data !== "object") return null;

  const dataKeys = Object.keys(data);
  if (dataKeys.length === 0) return null;

  const entryType = dataKeys[0];
  const entryData = data[entryType];

  const result: StateChange = {
    action,
    entryType,
    summary: "",
  };

  if (entryType === "contract_data" && entryData) {
    result.contractId = entryData.contract as string | undefined;
    const key = entryData.key;
    result.key = key ? formatScVal(key) : undefined;
    const durability = entryData.durability ?? "";
    result.summary = `${action} ${durability} contract_data${result.contractId ? ` on ${shortenId(result.contractId)}` : ""}${result.key ? `: ${result.key}` : ""}`;
  } else if (entryType === "contract_code") {
    result.summary = `${action} contract_code`;
  } else if (entryType === "account") {
    const accountId = entryData?.account_id;
    result.summary = `${action} account${accountId ? ` ${shortenId(String(accountId))}` : ""}`;
  } else if (entryType === "trustline") {
    result.summary = `${action} trustline`;
  } else {
    result.summary = `${action} ${entryType}`;
  }

  return result;
}

// --- Function Call Argument Formatting ---

/**
 * Format invoke_contract call arguments with ScVal-aware formatting.
 * Returns a structured object suitable for TOON encoding.
 */
export function formatInvokeCall(call: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (call.contract_address) {
    result.contract = String(call.contract_address);
  }
  if (call.function_name) {
    result.function = String(call.function_name);
  }
  if (call.args && Array.isArray(call.args)) {
    result.args = call.args.map(formatScVal);
  }
  return result;
}

/**
 * Format auth entries into a more readable structure.
 * Extracts the key fields: credential type, ledger bounds, contract contexts.
 */
export function formatAuthEntry(auth: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // soroban_credentials structure varies by type
  const credType = Object.keys(auth)[0];
  result.type = credType;

  if (credType === "soroban_credentials_source_account") {
    result.detail = "source account signature";
  } else if (credType === "soroban_credentials_address") {
    const cred = auth[credType] as Record<string, unknown> | undefined;
    if (cred) {
      if (cred.address) result.address = formatScVal(cred.address);
      if (cred.nonce !== undefined) result.nonce = String(cred.nonce);

      // Extract signature expiration ledger
      const sigExp = cred.signature_expiration_ledger;
      if (sigExp !== undefined) {
        result.signatureExpirationLedger = sigExp;
      }

      // Extract root invocation for context
      const rootInvocation = cred.root_invocation as Record<string, unknown> | undefined;
      if (rootInvocation) {
        const fn = rootInvocation.function as Record<string, unknown> | undefined;
        if (fn) {
          const invokeContract = fn.invoke_contract as Record<string, unknown> | undefined;
          if (invokeContract) {
            result.authorizedContract = invokeContract.contract_address;
            result.authorizedFunction = invokeContract.function_name;
          }
        }
        // Sub-invocations indicate cross-contract call auth
        const subInvocations = rootInvocation.sub_invocations;
        if (Array.isArray(subInvocations) && subInvocations.length > 0) {
          result.subInvocationCount = subInvocations.length;
        }
      }
    }
  }

  return result;
}
