import { xdr, Address, contract } from "@stellar/stellar-sdk";
import type { Env } from "./types.js";

const { Spec } = contract;

/**
 * Contract metadata — fetched on-chain via getLedgerEntries, cached in R2.
 * Includes the decoded Soroban contract spec (functions, errors, types).
 */
export interface ContractMetadata {
  contractId: string;
  wasmHash: string;
  functions: ContractFunction[];
  errorEnums: ContractErrorEnum[];
  structs: ContractStruct[];
  fetchedAt: string;
}

export interface ContractFunction {
  name: string;
  inputs: Array<{ name: string; type: string }>;
  outputs: string[];
}

export interface ContractErrorEnum {
  name: string;
  cases: Array<{ name: string; value: number }>;
}

export interface ContractStruct {
  name: string;
  fields: Array<{ name: string; type: string }>;
}

// --- R2 Cache ---

// In-memory cache for the current Worker invocation (avoids repeated R2 reads within a cycle)
const memoryCache = new Map<string, ContractMetadata | null>();

const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function getCachedContract(
  env: Env,
  contractId: string,
): Promise<ContractMetadata | null> {
  // Check in-memory first (free, same invocation)
  if (memoryCache.has(contractId)) {
    return memoryCache.get(contractId)!;
  }

  const obj = await env.ERRORS_BUCKET.get(`contracts/${contractId}.json`);
  if (!obj) {
    memoryCache.set(contractId, null);
    return null;
  }

  const meta: ContractMetadata = await obj.json();

  // Check if cache is stale (> 30 days)
  if (meta.fetchedAt) {
    const age = Date.now() - new Date(meta.fetchedAt).getTime();
    if (age > CACHE_MAX_AGE_MS) {
      console.log(`Contract ${contractId}: cache expired (${Math.floor(age / 86400000)}d old), refetching`);
      memoryCache.set(contractId, null);
      return null;
    }
  }

  memoryCache.set(contractId, meta);
  return meta;
}

async function cacheContract(env: Env, meta: ContractMetadata): Promise<void> {
  await env.ERRORS_BUCKET.put(
    `contracts/${meta.contractId}.json`,
    JSON.stringify(meta, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        contractId: meta.contractId,
        wasmHash: meta.wasmHash,
        functionCount: String(meta.functions.length),
        errorEnumCount: String(meta.errorEnums.length),
      },
    },
  );
}

// --- RPC: getLedgerEntries ---

async function rpcGetLedgerEntries(
  env: Env,
  keys: xdr.LedgerKey[],
): Promise<any[]> {
  const response = await fetch(env.STELLAR_ARCHIVE_RPC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.STELLAR_ARCHIVE_RPC_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "getLedgerEntries",
      params: { keys: keys.map((k) => k.toXDR("base64")) },
    }),
  });

  if (!response.ok) {
    throw new Error(`getLedgerEntries HTTP ${response.status}`);
  }

  const json: any = await response.json();
  if (json.error) {
    throw new Error(
      `getLedgerEntries error: ${json.error.message || JSON.stringify(json.error)}`,
    );
  }

  return json.result?.entries ?? [];
}

// --- Fetch Contract Metadata ---

export async function fetchContractMetadata(
  env: Env,
  contractId: string,
): Promise<ContractMetadata | null> {
  const cached = await getCachedContract(env, contractId);
  if (cached) return cached;

  try {
    // Step 1: Fetch contract instance to get WASM hash
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );

    const instanceEntries = await rpcGetLedgerEntries(env, [instanceKey]);
    if (instanceEntries.length === 0) {
      console.log(`Contract ${contractId}: not found on-chain`);
      return null;
    }

    // Decode XDR response to extract WASM hash
    const ledgerEntry = xdr.LedgerEntryData.fromXDR(
      instanceEntries[0].xdr,
      "base64",
    );
    const instance = ledgerEntry.contractData().val().instance();
    const wasmHash = instance.executable().wasmHash();
    const wasmHashHex = wasmHash.toString("hex");

    // Step 2: Fetch contract code (WASM)
    const codeKey = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: wasmHash }),
    );

    const codeEntries = await rpcGetLedgerEntries(env, [codeKey]);
    if (codeEntries.length === 0) {
      console.log(`Contract ${contractId}: WASM code not found`);
      return null;
    }

    const codeLedgerEntry = xdr.LedgerEntryData.fromXDR(
      codeEntries[0].xdr,
      "base64",
    );
    const wasmBytes = codeLedgerEntry.contractCode().code();

    // Step 3: Extract contractspecv0 from WASM and parse with Spec
    const specSection = extractWasmCustomSection(wasmBytes, "contractspecv0");
    if (!specSection) {
      console.log(`Contract ${contractId}: no contractspecv0 section in WASM`);
      return null;
    }

    const spec = new Spec(specSection as any);

    // Extract functions
    const functions: ContractFunction[] = spec.funcs().map((fn: any) => ({
      name: fn.name().toString(),
      inputs: fn.inputs().map((inp: any) => ({
        name: inp.name().toString(),
        type: describeSpecType(inp.type()),
      })),
      outputs: fn.outputs().map((out: any) => describeSpecType(out)),
    }));

    // Extract error enums
    const errorCases = spec.errorCases();
    const errorEnums: ContractErrorEnum[] =
      errorCases.length > 0
        ? [
            {
              name: "Error",
              cases: errorCases.map((c: any) => ({
                name: c.name().toString(),
                value: c.value(),
              })),
            },
          ]
        : [];

    // Extract structs via jsonSchema
    const structs: ContractStruct[] = [];
    try {
      const schema = spec.jsonSchema("");
      const defs = schema?.definitions ?? {};
      for (const [name, def] of Object.entries(defs) as [string, any][]) {
        if (def.properties && def.type === "object") {
          structs.push({
            name,
            fields: Object.entries(def.properties).map(
              ([fname, fdef]: [string, any]) => ({
                name: fname,
                type: fdef.type ?? fdef.$ref?.split("/").pop() ?? "unknown",
              }),
            ),
          });
        }
      }
    } catch {
      // jsonSchema can fail for some contracts — structs are optional context
    }

    const meta: ContractMetadata = {
      contractId,
      wasmHash: wasmHashHex,
      functions,
      errorEnums,
      structs,
      fetchedAt: new Date().toISOString(),
    };

    await cacheContract(env, meta);
    memoryCache.set(contractId, meta);

    console.log(
      `Contract ${contractId}: ${functions.length} fns, ${errorEnums.flatMap((e) => e.cases).length} error codes, ${structs.length} structs`,
    );

    return meta;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Contract fetch failed for ${contractId}: ${msg}`);
    // Cache the failure too so we don't retry within the same cycle
    memoryCache.set(contractId, null);
    return null;
  }
}

/**
 * Fetch metadata for all unique contracts in a list.
 * Lookups are deduped via in-memory cache (same cycle) and R2 cache (30-day TTL).
 * First fetch per contract costs 2 RPC calls; every subsequent lookup is free.
 */
export async function fetchContractsForError(
  env: Env,
  contractIds: string[],
): Promise<Map<string, ContractMetadata>> {
  const results = new Map<string, ContractMetadata>();
  const unique = [...new Set(contractIds)];

  for (const id of unique) {
    const meta = await fetchContractMetadata(env, id);
    if (meta) results.set(id, meta);
  }

  return results;
}

// --- WASM Custom Section Extraction ---

/**
 * Extract the first custom section with the given name from a WASM binary.
 * This is the only piece of custom binary parsing we need — the SDK handles everything else.
 */
function extractWasmCustomSection(
  wasm: Uint8Array,
  sectionName: string,
): Uint8Array | null {
  if (wasm.length < 8) return null;
  // Verify WASM magic: \0asm
  if (wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) {
    return null;
  }

  let offset = 8; // Skip magic + version

  while (offset < wasm.length) {
    const sectionId = wasm[offset++];
    const { value: size, bytesRead } = readLEB128(wasm, offset);
    offset += bytesRead;
    const sectionEnd = offset + size;

    if (sectionId === 0) {
      // Custom section — read name
      const { value: nameLen, bytesRead: nb } = readLEB128(wasm, offset);
      const nameStart = offset + nb;
      const name = new TextDecoder().decode(wasm.slice(nameStart, nameStart + nameLen));
      if (name === sectionName) {
        return wasm.slice(nameStart + nameLen, sectionEnd);
      }
    }

    offset = sectionEnd;
  }

  return null;
}

function readLEB128(
  bytes: Uint8Array,
  offset: number,
): { value: number; bytesRead: number } {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset < bytes.length) {
    const byte = bytes[offset++];
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  return { value: result, bytesRead };
}

// --- Spec Type Description ---

function describeSpecType(t: any): string {
  try {
    const name = t.switch().name;

    // Simple types — no .value() needed
    const simpleTypes: Record<string, string> = {
      scSpecTypeVal: "val",
      scSpecTypeBool: "bool",
      scSpecTypeVoid: "void",
      scSpecTypeError: "error",
      scSpecTypeU32: "u32",
      scSpecTypeI32: "i32",
      scSpecTypeU64: "u64",
      scSpecTypeI64: "i64",
      scSpecTypeTimepoint: "timepoint",
      scSpecTypeDuration: "duration",
      scSpecTypeU128: "u128",
      scSpecTypeI128: "i128",
      scSpecTypeU256: "u256",
      scSpecTypeI256: "i256",
      scSpecTypeBytes: "bytes",
      scSpecTypeString: "string",
      scSpecTypeSymbol: "symbol",
      scSpecTypeAddress: "address",
    };
    if (name in simpleTypes) return simpleTypes[name];

    // Parameterized types — need .value()
    switch (name) {
      case "scSpecTypeBytesN": {
        const n = t.value?.()?.n?.();
        return `bytes<${typeof n === "number" ? n : "N"}>`;
      }
      case "scSpecTypeOption": {
        const inner = t.value?.()?.valueType?.() ?? t.value?.();
        return `Option<${inner ? describeSpecType(inner) : "?"}>`;
      }
      case "scSpecTypeVec": {
        const elem = t.value?.()?.elementType?.() ?? t.value?.();
        return `Vec<${elem ? describeSpecType(elem) : "?"}>`;
      }
      case "scSpecTypeResult": {
        const ok = t.value?.()?.okType?.();
        const err = t.value?.()?.errorType?.();
        return `Result<${ok ? describeSpecType(ok) : "?"}, ${err ? describeSpecType(err) : "?"}>`;
      }
      case "scSpecTypeMap": {
        const kType = t.value?.()?.keyType?.();
        const vType = t.value?.()?.valueType?.();
        return `Map<${kType ? describeSpecType(kType) : "?"}, ${vType ? describeSpecType(vType) : "?"}>`;
      }
      case "scSpecTypeTuple": {
        const types = t.value?.()?.valueTypes?.() ?? [];
        return `(${types.map((tt: any) => describeSpecType(tt)).join(", ")})`;
      }
      case "scSpecTypeUdt": {
        const udtName = t.value?.()?.name?.();
        if (udtName && typeof udtName.toString === "function") return udtName.toString();
        return "UDT";
      }
      default:
        return name;
    }
  } catch {
    return "unknown";
  }
}

// --- Build Context String for AI ---

export function buildContractContext(
  contracts: Map<string, ContractMetadata>,
): string {
  if (contracts.size === 0) return "";

  const parts: string[] = ["\nContract Specifications:"];

  for (const [id, meta] of contracts) {
    parts.push(`\nContract: ${id}`);
    parts.push(`  WASM Hash: ${meta.wasmHash}`);

    if (meta.errorEnums.length > 0) {
      parts.push("  Error Codes:");
      for (const e of meta.errorEnums) {
        parts.push(`    enum ${e.name} {`);
        for (const c of e.cases) {
          parts.push(`      ${c.value} = ${c.name}`);
        }
        parts.push("    }");
      }
    }

    if (meta.functions.length > 0) {
      parts.push("  Functions:");
      for (const fn of meta.functions) {
        const params = fn.inputs
          .map((i) => `${i.name}: ${i.type}`)
          .join(", ");
        const ret =
          fn.outputs.length > 0 ? ` -> ${fn.outputs.join(", ")}` : "";
        parts.push(`    ${fn.name}(${params})${ret}`);
      }
    }

    if (meta.structs.length > 0) {
      parts.push("  Types:");
      for (const s of meta.structs) {
        const fields = s.fields
          .map((f) => `${f.name}: ${f.type}`)
          .join(", ");
        parts.push(`    struct ${s.name} { ${fields} }`);
      }
    }
  }

  return parts.join("\n");
}
