import { execFileSync } from "node:child_process";

const SEARCH_DOCS_INCLUDE_PATTERN = "/search-docs/**";
const AI_SEARCH_CUSTOM_METADATA = [
  { field_name: "fingerprint", data_type: "text" },
  { field_name: "error_category", data_type: "text" },
  { field_name: "function_name", data_type: "text" },
  { field_name: "primary_contract", data_type: "text" },
  { field_name: "operation_type", data_type: "text" },
];

const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const apiToken = resolveApiToken();
const instanceId = process.env.AI_SEARCH_INSTANCE_ID ?? "stellar-errors";
const sourceBucket = process.env.AI_SEARCH_SOURCE_BUCKET ?? "stellar-errors";
const searchModel =
  process.env.AI_SEARCH_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const tokenName = process.env.AI_SEARCH_SERVICE_TOKEN_NAME ?? "AI Search Service Token";

async function main() {
  const tokenId = await ensureAiSearchTokenId();
  const payload = {
    id: instanceId,
    token_id: tokenId,
    type: "r2",
    source: sourceBucket,
    source_params: {
      include_items: [SEARCH_DOCS_INCLUDE_PATTERN],
    },
    custom_metadata: AI_SEARCH_CUSTOM_METADATA,
    index_method: {
      vector: true,
      keyword: true,
    },
    retrieval_options: {
      keyword_match_mode: "and",
      boost_by: [{ field: "timestamp", direction: "desc" }],
    },
    reranking: true,
    reranking_model: "@cf/baai/bge-reranker-base",
    rewrite_query: true,
    ai_search_model: searchModel,
    max_num_results: 8,
  };

  const existing = await request("GET", `/accounts/${accountId}/ai-search/instances/${instanceId}`, undefined, {
    allow404: true,
  });

  if (existing === null) {
    const created = await request("POST", `/accounts/${accountId}/ai-search/instances`, payload);
    console.log(JSON.stringify({
      action: "created",
      instanceId,
      tokenId,
      sourceBucket,
      payload,
      result: created.result,
    }, null, 2));
    return;
  }

  const updated = await request(
    "PUT",
    `/accounts/${accountId}/ai-search/instances/${instanceId}`,
    payload,
  );
  console.log(JSON.stringify({
    action: "updated",
    instanceId,
    tokenId,
    sourceBucket,
    payload,
    result: updated.result,
  }, null, 2));
}

async function ensureAiSearchTokenId() {
  if (process.env.CLOUDFLARE_AI_SEARCH_TOKEN_ID) {
    return process.env.CLOUDFLARE_AI_SEARCH_TOKEN_ID;
  }

  const serviceApiId = process.env.CLOUDFLARE_SERVICE_API_ID;
  const serviceApiKey = process.env.CLOUDFLARE_SERVICE_API_KEY;
  if (!serviceApiId || !serviceApiKey) {
    throw new Error(
      "Set CLOUDFLARE_AI_SEARCH_TOKEN_ID or provide CLOUDFLARE_SERVICE_API_ID and CLOUDFLARE_SERVICE_API_KEY.",
    );
  }

  const tokens = await request("GET", `/accounts/${accountId}/ai-search/tokens`);
  const existing = Array.isArray(tokens.result)
    ? tokens.result.find((token) => token.name === tokenName && token.cf_api_id === serviceApiId)
    : null;
  if (existing?.id) {
    return existing.id;
  }

  const created = await request("POST", `/accounts/${accountId}/ai-search/tokens`, {
    name: tokenName,
    cf_api_id: serviceApiId,
    cf_api_key: serviceApiKey,
  });
  if (!created.result?.id) {
    throw new Error("AI Search token registration succeeded without returning a token id.");
  }
  return created.result.id;
}

async function request(method, path, body, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (options.allow404 && response.status === 404) {
    return null;
  }

  const json = await response.json();
  if (!response.ok || json.success === false) {
    throw new Error(
      `Cloudflare API ${method} ${path} failed: ${response.status} ${JSON.stringify(json.errors ?? json)}`,
    );
  }
  return json;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolveApiToken() {
  const explicitToken = process.env.CLOUDFLARE_AI_SEARCH_API_TOKEN?.trim();
  if (explicitToken) {
    return explicitToken;
  }

  try {
    const output = execFileSync("npx", ["wrangler", "auth", "token", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(output);
    const token =
      parsed.token ??
      parsed.apiToken ??
      parsed.oauth_token ??
      parsed.value;
    if (typeof token === "string" && token.trim()) {
      return token.trim();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Missing CLOUDFLARE_AI_SEARCH_API_TOKEN and failed to retrieve one from Wrangler auth: ${message}`,
    );
  }

  throw new Error(
    "Missing CLOUDFLARE_AI_SEARCH_API_TOKEN and Wrangler auth did not return a usable token.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
