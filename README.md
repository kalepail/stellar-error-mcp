# stellar-error-mcp

A Cloudflare Worker that continuously scans the Stellar blockchain for failed Soroban transactions, accepts direct RPC error submissions for failed `sendTransaction` and `simulateTransaction` calls, runs all long-lived work on Cloudflare Workflows, and exposes the resulting error knowledge base via a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server.

## How it works

1. **Scan** — Every 5 minutes, fetches recent ledgers from the Stellar Archive RPC and extracts failed Soroban transactions (invoke, restore, extend operations).
2. **Forward** — Internal callers can submit raw RPC failures directly. Exact duplicates are detected inline; new errors are normalized once, staged in R2, and handed off to Workflow-backed async jobs.
3. **Fingerprint** — Computes a SHA-256 fingerprint from contracts, function name, error signatures, and result kind. Duplicate errors increment a counter instead of being re-analyzed.
4. **Semantic dedup** — New errors are embedded with `@cf/baai/bge-base-en-v1.5` and checked against a Vectorize index. Similar errors (score >= 0.90) are linked together.
5. **Decode and enrich** — Each failed transaction is normalized into a first-class decoded artifact containing the raw envelope/processing JSON, recursively XDR-decoded views, invoke/auth/resource summaries, operation-level effects, ledger changes, and touched contract IDs.
6. **Analyze** — Unique errors are sent to a Cloudflare AI model with the full enriched transaction plus contract specs and decoded WASM custom sections, encoded as TOON for high-fidelity LLM input. The model returns a structured analysis: summary, evidence-based classification, likely cause, suggested fix, related codes, debug steps, detailed analysis, and confidence level.
7. **Store** — Canonical error entries, example transactions, tx-hash pointers, public job snapshots, private Workflow inputs, staged Workflow artifacts, result artifacts, and contract metadata snapshots are persisted to R2. Each error also emits a curated Markdown document under `search-docs/` for AI Search indexing. Vectors are indexed in Vectorize for ingest-time semantic dedup.
8. **Serve** — An MCP server exposes tools (`diagnose_error`, `get_error`, `get_error_example`, `decode_xdr`) so AI agents can query the knowledge base with natural language or raw XDR blobs.

## Prerequisites

- Node.js
- A Cloudflare account with access to Workers, Workflows, R2, KV, Vectorize, AI, and AI Search
- A Stellar Archive RPC token

## Cloudflare resources

Create these before deploying:

| Resource | Name / Config |
|---|---|
| R2 Bucket | `stellar-errors` |
| KV Namespace | any — put the ID in `wrangler.jsonc` |
| Vectorize Index | `stellar-error-fingerprints` (model: `@cf/baai/bge-base-en-v1.5`) |
| AI Search | `stellar-errors` (R2-backed, scoped to `search-docs/**`) |
| Workflows | `stellar-error-direct`, `stellar-error-ledger-range` |

## Setup

```bash
npm install
```

Review `wrangler.jsonc` before deploying:

- If you are deploying in a different Cloudflare account, replace the bound resource IDs and names with resources from that account.
- Keep local preview and production resources separate if you do not want preview traffic writing into the production data plane.

Create a `.dev.vars` file with your RPC token:

```
STELLAR_ARCHIVE_RPC_TOKEN=your_token_here
```

Optional real-time RPC settings for Quasar Pro:

```
STELLAR_RPC_ENDPOINT=https://rpc-pro.lightsail.network
STELLAR_RPC_AUTH_MODE=header
```

`STELLAR_ARCHIVE_RPC_TOKEN` is reused for both archive and real-time RPC by default. If you prefer URL-path auth, set `STELLAR_RPC_AUTH_MODE=path`.

For deployed admin endpoints, also set a management token secret:

```bash
wrangler secret put MANAGEMENT_TOKEN
```

Provision or update the AI Search instance from code instead of the dashboard:

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_AI_SEARCH_TOKEN_ID=...
npm run provision:ai-search
```

If you are already logged in with `wrangler login`, the script will automatically reuse the active Wrangler auth token. Set `CLOUDFLARE_AI_SEARCH_API_TOKEN` only if you want to override that behavior.

If you do not already have an AI Search token registered, provide `CLOUDFLARE_SERVICE_API_ID` and `CLOUDFLARE_SERVICE_API_KEY` instead of `CLOUDFLARE_AI_SEARCH_TOKEN_ID`. Those credentials come from the service-token flow documented in Cloudflare's AI Search API setup.

## Development

```bash
npm run dev         # local dev server with cron test mode
npm run types       # generate Cloudflare Worker types
```

Start or reuse the recurring scan Workflow:

```bash
curl -X POST http://localhost:8787/trigger
```

For deployed `/trigger` and `/batch` endpoints, send either `Authorization: Bearer <token>` or `x-management-token: <token>`.

Forward a direct RPC error:

```bash
curl -X POST http://localhost:8787/forward-error \
  -H 'content-type: application/json' \
  -d '{
    "kind": "rpc_send",
    "transactionXdr": "AAAA...",
    "response": {
      "status": "ERROR",
      "hash": "abc123",
      "latestLedger": 123,
      "errorResultXdr": "AAAA...",
      "diagnosticEventsXdr": ["AAAA..."]
    }
  }'
```

If the submission is an exact duplicate, the endpoint returns `200 { status: "duplicate", ... }` immediately.

If the submission is new, poll the returned job later:

```bash
curl http://localhost:8787/jobs/de_<id>
```

The public job response is the only polling surface. There is no `/jobs/:jobId/process` endpoint.

Run the live RPC shape-capture suite:

```bash
export STELLAR_ARCHIVE_RPC_TOKEN=...
export STELLAR_RPC_ENDPOINT=https://rpc-pro.lightsail.network
export STELLAR_RPC_AUTH_MODE=header
npm run test:live-rpc
```

Optional for networks without Friendbot:

```bash
export LIVE_RPC_SOURCE_SECRET=SC...
```

The live suite writes raw and normalized observations to `.context/live-rpc-observations/<network>/` so you can inspect the exact `simulateTransaction`, `sendTransaction`, and `getTransaction` payload shapes returned by the RPC.

## Deploy

```bash
npm run deploy
```

## HTTP endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service status and last processed ledger |
| `POST` | `/trigger` | Start or reuse the recurring scan Workflow |
| `POST` | `/batch?hours=24` | Create an async backfill job for a time range |
| `POST` | `/batch?start=N&end=M` | Backfill a specific ledger range |
| `POST` | `/forward-error` | Return an inline duplicate or create a Workflow-backed direct error job |
| `GET` | `/jobs/:jobId` | Public polling endpoint for Workflow-backed jobs |
| `POST` | `/mcp` | MCP protocol endpoint |

## MCP tools

**`diagnose_error`** — Search the knowledge base with an error message, contract ID, or base64 XDR blob. Returns an AI-synthesized diagnosis with sources.

**`get_error`** — Retrieve a specific error entry by fingerprint or find entries containing a transaction hash. Returns the error entry together with the stored example transaction record when available.

**`get_error_example`** — Get the stored example transaction record for a fingerprint, including the raw transaction JSON, decoded transaction context, and contract metadata snapshot used during analysis.

**`decode_xdr`** — Decode arbitrary base64 XDR blobs into rich JSON with automatic type guessing.

**`search_errors`** — Return raw matching AI Search chunks without synthesized analysis. Supports metadata filters aligned with the `search-docs/` schema.

**`list_errors`** — List stored error/example objects in R2.

## Project structure

```
src/
  index.ts          Entry point, HTTP routing, cron orchestration
  workflows.ts      Workflow classes for direct errors and ledger ranges
  jobs.ts           Job id generation, duplicate preflight, public sanitization
  stellar.ts        Ledger scanning, RPC client, transaction extraction
  transaction.ts    Shared transaction decoding and normalization helpers
  analysis.ts       AI analysis prompts and model calls
  fingerprint.ts    SHA-256 fingerprinting, error signature extraction
  ai-search.ts      AI Search document generation, metadata schema, and filters
  storage.ts        R2 / KV / Vectorize operations
  contracts.ts      On-chain contract spec and WASM custom section fetching/caching
  mcp.ts            MCP server and tool definitions
  xdr.ts            Base64 XDR decoding utilities
  types.ts          TypeScript type definitions
```

## Configuration

Key constants in `src/workflows.ts`:

| Constant | Default | Description |
|---|---|---|
| `MAX_LEDGERS_PER_CYCLE` | 200 | Ledgers processed per cron trigger |
| `COLD_START_LOOKBACK` | 50 | Ledgers to look back on first run |

AI Search and analysis models are configured separately in `wrangler.jsonc` under `vars`.

## R2 layout

- `errors/<fingerprint>.json`: canonical structured error records
- `examples/<fingerprint>.json`: stored example transactions and contract snapshots
- `jobs/<jobId>.json`: public async job snapshots
- `job-inputs/<jobId>.json`: private Workflow inputs and staged-artifact references
- `job-results/<jobId>.json`: larger batch result artifacts
- `job-staging/<jobId>/...`: staged Workflow transaction artifacts and step results
- `tx-index/<txHash>.json`: direct tx-hash to fingerprint pointers
- `search-docs/<fingerprint>.md`: the only documents intended for AI Search indexing
