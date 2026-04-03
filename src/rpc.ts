import type { Env } from "./types.js";

type RpcMethod =
  | "getLatestLedger"
  | "getLedgerEntries"
  | "getLedgers";

interface RpcRequestOptions {
  endpoint: string;
  token: string;
  authMode?: Env["STELLAR_RPC_AUTH_MODE"];
  method: RpcMethod;
  params?: Record<string, unknown>;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function buildRpcUrl(
  endpoint: string,
  token: string,
  authMode: Env["STELLAR_RPC_AUTH_MODE"] = "header",
): string {
  const normalized = trimTrailingSlashes(endpoint);
  if (authMode === "path") {
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
      ...(options.authMode === "path"
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
