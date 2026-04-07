import type { Env, TransactionRpcContext } from "./types.js";

type RpcMethod =
  | "getLatestLedger"
  | "getLedgerEntries"
  | "getLedgers"
  | "getTransaction";

interface RpcRequestOptions {
  endpoint: string;
  token?: string;
  authMode?: Env["STELLAR_RPC_AUTH_MODE"];
  method: RpcMethod;
  params?: Record<string, unknown>;
}

export interface ResolvedRpcConfig {
  rpcEndpoint: string;
  archiveRpcEndpoint: string;
  token?: string;
  authMode: Env["STELLAR_RPC_AUTH_MODE"];
  scope: string;
}

interface RpcRequestWithEnvOptions {
  method: RpcMethod;
  params?: Record<string, unknown>;
  useArchiveEndpoint?: boolean;
}

const TESTNET_LAST_SUCCESS_KEY = "rpc:testnet:last_success_endpoint";
const DEFAULT_TESTNET_RPC_ENDPOINTS = [
  "https://stellar-soroban-testnet-public.nodies.app",
  "https://soroban-rpc.testnet.stellar.gateway.fm",
  "https://soroban-testnet.stellar.org",
];

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function buildRpcUrl(
  endpoint: string,
  token = "",
  authMode: Env["STELLAR_RPC_AUTH_MODE"] = "header",
): string {
  const normalized = trimTrailingSlashes(endpoint);
  if (authMode === "path" && token) {
    return `${normalized}/${encodeURIComponent(token)}`;
  }
  return normalized;
}

export async function rpcRequest(
  options: RpcRequestOptions,
): Promise<any> {
  const url = buildRpcUrl(options.endpoint, options.token, options.authMode);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.authMode === "path" || !options.token
        ? {}
        : { Authorization: `Bearer ${options.token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: options.method,
      ...(options.params ? { params: options.params } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`${options.method} HTTP ${response.status}: ${await response.text()}`);
  }

  const json: any = await response.json();
  if (json.error) {
    throw new Error(
      `${options.method} error: ${json.error.message || JSON.stringify(json.error)}`,
    );
  }

  return json.result;
}

export function getRealtimeRpcEndpoint(env: Env): string {
  return env.STELLAR_RPC_ENDPOINT?.trim() || env.STELLAR_ARCHIVE_RPC_ENDPOINT;
}

export function getRpcAuthMode(env: Env): Env["STELLAR_RPC_AUTH_MODE"] {
  return env.STELLAR_RPC_AUTH_MODE === "path" ? "path" : "header";
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(
    values
      .map((value) => value?.trim())
      .filter((value): value is string => !!value),
  )];
}

async function getLastSuccessfulTestnetEndpoint(env: Env): Promise<string | null> {
  try {
    return await env.CURSOR_KV.get(TESTNET_LAST_SUCCESS_KEY);
  } catch {
    return null;
  }
}

async function setLastSuccessfulTestnetEndpoint(env: Env, endpoint: string): Promise<void> {
  try {
    await env.CURSOR_KV.put(TESTNET_LAST_SUCCESS_KEY, endpoint);
  } catch {
    // KV writes are best-effort for endpoint preference.
  }
}

function rotateCandidates(candidates: string[], preferred: string | null): string[] {
  if (!preferred) return candidates;
  const index = candidates.indexOf(preferred);
  if (index <= 0) return candidates;
  return [...candidates.slice(index), ...candidates.slice(0, index)];
}

async function getTestnetRpcCandidates(
  env: Env,
  context: TransactionRpcContext | undefined,
  useArchiveEndpoint: boolean,
): Promise<string[]> {
  const configured = uniqueStrings([
    useArchiveEndpoint ? context?.archiveRpcEndpoint : context?.rpcEndpoint,
    useArchiveEndpoint
      ? env.STELLAR_TESTNET_ARCHIVE_RPC_ENDPOINT
      : env.STELLAR_TESTNET_RPC_ENDPOINT,
  ]);
  const defaults = [...DEFAULT_TESTNET_RPC_ENDPOINTS];
  const combined = uniqueStrings([...configured, ...defaults]);
  const preferred = await getLastSuccessfulTestnetEndpoint(env);

  if (configured.length > 0 && preferred && !configured.includes(preferred)) {
    return [...configured, ...rotateCandidates(
      combined.filter((endpoint) => !configured.includes(endpoint)),
      preferred,
    )];
  }

  return rotateCandidates(combined, preferred);
}

function sanitizeScopePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "default";
}

export function resolveRpcConfig(
  env: Env,
  context?: TransactionRpcContext,
): ResolvedRpcConfig {
  const requestedNetwork = context?.network;
  const authMode = context?.authMode
    ?? (requestedNetwork === "testnet"
      ? env.STELLAR_TESTNET_RPC_AUTH_MODE
      : env.STELLAR_RPC_AUTH_MODE)
    ?? "header";

  if (requestedNetwork === "testnet") {
    const rpcEndpoint = context?.rpcEndpoint?.trim()
      || env.STELLAR_TESTNET_RPC_ENDPOINT?.trim()
      || getRealtimeRpcEndpoint(env);
    const archiveRpcEndpoint = context?.archiveRpcEndpoint?.trim()
      || env.STELLAR_TESTNET_ARCHIVE_RPC_ENDPOINT?.trim()
      || rpcEndpoint;
    return {
      rpcEndpoint,
      archiveRpcEndpoint,
      token: env.STELLAR_TESTNET_RPC_TOKEN?.trim() || undefined,
      authMode,
      scope: "network:testnet",
    };
  }

  if (requestedNetwork === "futurenet" || requestedNetwork === "custom") {
    const rpcEndpoint = context?.rpcEndpoint?.trim();
    if (!rpcEndpoint) {
      throw new Error(
        `network '${requestedNetwork}' requires an explicit rpcEndpoint; refusing to fall back to mainnet defaults`,
      );
    }
    const archiveRpcEndpoint = context?.archiveRpcEndpoint?.trim() || rpcEndpoint;
    const endpointScope = sanitizeScopePart(archiveRpcEndpoint || rpcEndpoint);
    return {
      rpcEndpoint,
      archiveRpcEndpoint,
      token: env.STELLAR_ARCHIVE_RPC_TOKEN,
      authMode,
      scope: `network:${requestedNetwork}:endpoint:${endpointScope}`,
    };
  }

  const rpcEndpoint = context?.rpcEndpoint?.trim()
    || getRealtimeRpcEndpoint(env);
  const archiveRpcEndpoint = context?.archiveRpcEndpoint?.trim()
    || env.STELLAR_ARCHIVE_RPC_ENDPOINT;
  const scope = requestedNetwork
    ? `network:${requestedNetwork}`
    : `endpoint:${sanitizeScopePart(context?.archiveRpcEndpoint || context?.rpcEndpoint || rpcEndpoint)}`;

  return {
    rpcEndpoint,
    archiveRpcEndpoint,
    token: env.STELLAR_ARCHIVE_RPC_TOKEN,
    authMode,
    scope,
  };
}

export async function rpcRequestWithEnv(
  env: Env,
  options: RpcRequestWithEnvOptions,
  context?: TransactionRpcContext,
): Promise<any> {
  const config = resolveRpcConfig(env, context);

  if (context?.network !== "testnet") {
    return rpcRequest({
      endpoint: options.useArchiveEndpoint ? config.archiveRpcEndpoint : config.rpcEndpoint,
      token: config.token,
      authMode: config.authMode,
      method: options.method,
      params: options.params,
    });
  }

  const candidates = await getTestnetRpcCandidates(
    env,
    context,
    options.useArchiveEndpoint === true,
  );
  const failures: string[] = [];

  for (const endpoint of candidates) {
    try {
      const result = await rpcRequest({
        endpoint,
        token: config.token,
        authMode: config.authMode,
        method: options.method,
        params: options.params,
      });
      await setLastSuccessfulTestnetEndpoint(env, endpoint);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${endpoint}: ${message}`);
      console.warn(JSON.stringify({
        level: "warn",
        event: "rpc.testnet_endpoint_failed",
        endpoint,
        method: options.method,
        error: message,
      }));
    }
  }

  throw new Error(
    `All testnet RPC endpoints failed for ${options.method}: ${failures.join(" | ")}`,
  );
}
