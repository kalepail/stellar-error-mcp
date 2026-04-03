import { xdr, Address, contract } from "@stellar/stellar-sdk";
import type {
  ContractCustomSections,
  ContractErrorEnum,
  ContractFunction,
  ContractMetadata,
  ContractStruct,
  Env,
} from "./types.js";
import { decodeXdrStream } from "./xdr.js";
import { getRealtimeRpcEndpoint, getRpcAuthMode, rpcRequest } from "./rpc.js";

const { Spec } = contract;

// --- R2 Cache ---

const NEGATIVE_CACHE = Symbol("negative-contract-cache");
const STALE_CACHE = Symbol("stale-contract-cache");
type MemoryCacheValue =
  | ContractMetadata
  | typeof NEGATIVE_CACHE
  | typeof STALE_CACHE;

// In-memory cache for the current Worker invocation (avoids repeated R2 reads within a cycle)
const memoryCache = new Map<string, MemoryCacheValue>();

const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_CONTEXT_DOC_LENGTH = 240;
const CONTRACT_SECTION_TYPES = {
  contractspecv0: "ScSpecEntry",
  contractmetav0: "ScMetaEntry",
  contractenvmetav0: "ScEnvMetaEntry",
} as const;

export async function getCachedContract(
  env: Env,
  contractId: string,
): Promise<
  | { hit: true; value: ContractMetadata | null }
  | { hit: false }
> {
  // Tier 1: In-memory (free, same invocation)
  if (memoryCache.has(contractId)) {
    const cached = memoryCache.get(contractId)!;
    if (cached === NEGATIVE_CACHE) {
      return { hit: true, value: null };
    }
    if (cached === STALE_CACHE) {
      return { hit: false };
    }
    return { hit: true, value: cached };
  }

  // Tier 2: Cache API (free, same datacenter, persists across invocations)
  const cacheKey = new Request(`https://cache.internal/contracts/${contractId}`);
  try {
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const meta: ContractMetadata = await cached.json();
      if (meta.fetchedAt) {
        const age = Date.now() - new Date(meta.fetchedAt).getTime();
        if (age <= CACHE_MAX_AGE_MS) {
          memoryCache.set(contractId, meta);
          return { hit: true, value: meta };
        }
      }
    }
  } catch {
    // Cache API may not be available in local dev
  }

  // Tier 3: R2 (persistent, global)
  const obj = await env.ERRORS_BUCKET.get(`contracts/${contractId}.json`);
  if (!obj) {
    return { hit: false };
  }

  const meta: ContractMetadata = await obj.json();

  // Check if cache is stale (> 30 days)
  if (meta.fetchedAt) {
    const age = Date.now() - new Date(meta.fetchedAt).getTime();
    if (age > CACHE_MAX_AGE_MS) {
      console.log(JSON.stringify({
        level: "info",
        event: "contracts.cache_expired",
        contractId,
        ageDays: Math.floor(age / 86400000),
      }));
      memoryCache.set(contractId, STALE_CACHE);
      return { hit: false };
    }
  }

  memoryCache.set(contractId, meta);

  // Backfill Cache API for future invocations
  try {
    const cache = caches.default;
    const cacheResponse = new Response(JSON.stringify(meta), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400", // 24h datacenter-local
      },
    });
    // Fire-and-forget — don't block on cache write
    cache.put(cacheKey, cacheResponse).catch(() => {});
  } catch {
    // Cache API may not be available
  }

  return { hit: true, value: meta };
}

async function cacheContract(env: Env, meta: ContractMetadata): Promise<void> {
  const json = JSON.stringify(meta, null, 2);

  // R2: persistent global cache
  await env.ERRORS_BUCKET.put(
    `contracts/${meta.contractId}.json`,
    json,
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

  // Cache API: datacenter-local, free
  try {
    const cache = caches.default;
    const cacheKey = new Request(`https://cache.internal/contracts/${meta.contractId}`);
    const cacheResponse = new Response(json, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
      },
    });
    cache.put(cacheKey, cacheResponse).catch(() => {});
  } catch {
    // Cache API may not be available
  }
}

// --- RPC: getLedgerEntries ---

async function rpcGetLedgerEntries(
  env: Env,
  keys: xdr.LedgerKey[],
): Promise<any[]> {
  const result = await rpcRequest({
    endpoint: getRealtimeRpcEndpoint(env),
    token: env.STELLAR_ARCHIVE_RPC_TOKEN,
    authMode: getRpcAuthMode(env),
    method: "getLedgerEntries",
    params: { keys: keys.map((k) => k.toXDR("base64")) },
  });
  return result?.entries ?? [];
}

// --- Fetch Contract Metadata ---

export async function fetchContractMetadata(
  env: Env,
  contractId: string,
): Promise<ContractMetadata | null> {
  const cached = await getCachedContract(env, contractId);
  if (cached.hit) return cached.value;

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
      console.log(JSON.stringify({
        level: "info",
        event: "contracts.not_found",
        contractId,
      }));
      memoryCache.set(contractId, NEGATIVE_CACHE);
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
      console.log(JSON.stringify({
        level: "info",
        event: "contracts.code_missing",
        contractId,
      }));
      memoryCache.set(contractId, NEGATIVE_CACHE);
      return null;
    }

    const codeLedgerEntry = xdr.LedgerEntryData.fromXDR(
      codeEntries[0].xdr,
      "base64",
    );
    const wasmBytes = codeLedgerEntry.contractCode().code();

    // Step 3: Extract contractspecv0 from WASM and parse with Spec
    const specSections = extractWasmCustomSections(wasmBytes, "contractspecv0");
    const specSection = specSections[0];
    if (!specSection) {
      console.log(JSON.stringify({
        level: "info",
        event: "contracts.spec_missing",
        contractId,
      }));
      memoryCache.set(contractId, NEGATIVE_CACHE);
      return null;
    }

    const spec = new Spec(specSection as any);

    // Extract functions (including doc comments from /// in Rust source)
    const functions: ContractFunction[] = spec.funcs().map((fn: any) => {
      const entry: ContractFunction = {
        name: fn.name().toString(),
        inputs: fn.inputs().map((inp: any) => ({
          name: inp.name().toString(),
          type: describeSpecType(inp.type()),
        })),
        outputs: fn.outputs().map((out: any) => describeSpecType(out)),
      };
      try {
        const doc = fn.doc?.()?.toString?.();
        if (doc) entry.doc = doc;
      } catch {
        // doc() may not exist on older SDK versions
      }
      return entry;
    });

    // Extract error enums (including per-case doc comments)
    const errorCases = spec.errorCases();
    const errorEnums: ContractErrorEnum[] =
      errorCases.length > 0
        ? [
            {
              name: "Error",
              cases: errorCases.map((c: any) => {
                const entry: ContractErrorEnum["cases"][number] = {
                  name: c.name().toString(),
                  value: c.value(),
                };
                try {
                  const doc = c.doc?.()?.toString?.();
                  if (doc) entry.doc = doc;
                } catch {
                  // doc() may not exist
                }
                return entry;
              }),
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

    const customSections = decodeKnownContractSections(wasmBytes);

    const meta: ContractMetadata = {
      contractId,
      wasmHash: wasmHashHex,
      functions,
      errorEnums,
      structs,
      customSections,
      fetchedAt: new Date().toISOString(),
    };

    await cacheContract(env, meta);
    memoryCache.set(contractId, meta);

    console.log(JSON.stringify({
      level: "info",
      event: "contracts.fetched",
      contractId,
      functionCount: functions.length,
      errorCodeCount: errorEnums.flatMap((e) => e.cases).length,
      structCount: structs.length,
    }));

    return meta;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      level: "error",
      event: "contracts.fetch_failed",
      contractId,
      error: msg,
    }));
    // Cache the failure too so we don't retry within the same cycle
    memoryCache.set(contractId, NEGATIVE_CACHE);
    return null;
  }
}

export function resetContractCacheForTests(): void {
  memoryCache.clear();
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

  // Fetch all contracts in parallel — each one has its own caching layers
  const settled = await Promise.allSettled(
    unique.map(async (id) => {
      const meta = await fetchContractMetadata(env, id);
      return { id, meta };
    }),
  );

  for (const result of settled) {
    if (result.status === "fulfilled" && result.value.meta) {
      results.set(result.value.id, result.value.meta);
    }
  }

  return results;
}

// --- WASM Custom Section Extraction ---

/**
 * Extract all custom sections with the given name from a WASM binary.
 */
function extractWasmCustomSections(
  wasm: Uint8Array,
  sectionName: string,
): Uint8Array[] {
  const matches: Uint8Array[] = [];
  if (wasm.length < 8) return matches;
  // Verify WASM magic: \0asm
  if (wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) {
    return matches;
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
        matches.push(wasm.slice(nameStart + nameLen, sectionEnd));
      }
    }

    offset = sectionEnd;
  }

  return matches;
}

function decodeKnownContractSections(
  wasm: Uint8Array,
): ContractCustomSections | undefined {
  const decoded: ContractCustomSections = {};

  for (const [sectionName, xdrType] of Object.entries(CONTRACT_SECTION_TYPES)) {
    const sections = extractWasmCustomSections(wasm, sectionName);
    if (sections.length === 0) continue;

    const entries = sections.flatMap((section) => {
      const xdrBase64 = uint8ArrayToBase64(section);
      return decodeXdrStream(xdrType, xdrBase64) ?? [];
    });

    if (entries.length > 0) {
      decoded[sectionName as keyof ContractCustomSections] = entries;
    }
  }

  return Object.keys(decoded).length > 0 ? decoded : undefined;
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

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
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
          const doc = normalizeContextDoc(c.doc);
          const docStr = doc ? `  // ${doc}` : "";
          parts.push(`      ${c.value} = ${c.name}${docStr}`);
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
        const doc = normalizeContextDoc(fn.doc);
        if (doc) {
          parts.push(`    /// ${doc}`);
        }
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

    if (meta.customSections?.contractspecv0?.length) {
      parts.push(
        `  Raw Spec Entries: ${meta.customSections.contractspecv0.length}`,
      );
    }
    if (meta.customSections?.contractenvmetav0?.length) {
      parts.push(
        `  Contract Env Meta Entries: ${meta.customSections.contractenvmetav0.length}`,
      );
      parts.push(
        `  Contract Env Meta Preview: ${renderCustomSectionPreview(meta.customSections.contractenvmetav0)}`,
      );
    }
    if (meta.customSections?.contractmetav0?.length) {
      parts.push(
        `  Contract Meta Entries: ${meta.customSections.contractmetav0.length}`,
      );
      parts.push(
        `  Contract Meta Preview: ${renderCustomSectionPreview(meta.customSections.contractmetav0)}`,
      );
    }
  }

  return parts.join("\n");
}

function normalizeContextDoc(doc?: string): string {
  if (!doc) return "";

  const collapsed = doc.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= MAX_CONTEXT_DOC_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_CONTEXT_DOC_LENGTH - 1).trimEnd()}...`;
}

function renderCustomSectionPreview(entries: unknown[]): string {
  const preview = JSON.stringify(entries.slice(0, 2));
  return preview.length > 300
    ? `${preview.slice(0, 300)}...`
    : preview;
}
