# stellar-error-mcp

A Cloudflare Worker that continuously scans the Stellar blockchain for failed Soroban transactions, deduplicates and analyzes them with AI, and exposes the resulting error knowledge base via a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server.

## How it works

1. **Scan** — Every 5 minutes, fetches recent ledgers from the Stellar Archive RPC and extracts failed Soroban transactions (invoke, restore, extend operations).
2. **Fingerprint** — Computes a SHA-256 fingerprint from contracts, function name, error signatures, and result kind. Duplicate errors increment a counter instead of being re-analyzed.
3. **Semantic dedup** — New errors are embedded with `@cf/baai/bge-base-en-v1.5` and checked against a Vectorize index. Similar errors (score >= 0.90) are linked together.
4. **Analyze** — Unique errors are sent to a Cloudflare AI model with full transaction context (envelopes, auth, resources, diagnostic events, contract specs). The model returns a structured analysis: summary, category, likely cause, suggested fix, and confidence level.
5. **Store** — Error entries, example transactions, and contract metadata are persisted to R2. Vectors are indexed in Vectorize. Documents are indexed in AI Search.
6. **Serve** — An MCP server exposes tools (`diagnose_error`, `get_error`, `get_error_example`, `search_errors`, `decode_xdr`, `list_errors`) so AI agents can query the knowledge base with natural language or raw XDR blobs.

## Prerequisites

- Node.js
- A Cloudflare account with access to Workers, R2, KV, Vectorize, AI, and AI Search
- A Stellar Archive RPC token

## Cloudflare resources

Create these before deploying:

| Resource | Name / Config |
|---|---|
| R2 Bucket | `stellar-errors` |
| KV Namespace | any — put the ID in `wrangler.jsonc` |
| Vectorize Index | `stellar-error-fingerprints` (model: `@cf/baai/bge-base-en-v1.5`) |
| AI Search | `stellar-errors` |

## Setup

```bash
npm install
```

Update `wrangler.jsonc` — replace `PLACEHOLDER` with your KV namespace ID.

Create a `.dev.vars` file with your RPC token:

```
STELLAR_ARCHIVE_RPC_TOKEN=your_token_here
```

For deployed admin endpoints, also set a management token secret:

```bash
wrangler secret put MANAGEMENT_TOKEN
```

## Development

```bash
npm run dev         # local dev server with cron test mode
npm run types       # generate Cloudflare Worker types
```

Trigger a scan manually:

```bash
curl -X POST http://localhost:8787/trigger
```

For deployed `/trigger` and `/batch` endpoints, send either `Authorization: Bearer <token>` or `x-management-token: <token>`.

## Deploy

```bash
npm run deploy
```

## HTTP endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service status and last processed ledger |
| `POST` | `/trigger` | Run one scan cycle |
| `POST` | `/batch?hours=24` | Backfill a time range (streams NDJSON progress) |
| `POST` | `/batch?start=N&end=M` | Backfill a specific ledger range |
| `POST` | `/mcp` | MCP protocol endpoint |

## MCP tools

**`diagnose_error`** — Search the knowledge base with an error message, contract ID, or base64 XDR blob. Returns an AI-synthesized diagnosis with sources.

**`get_error`** — Retrieve a specific error entry by fingerprint or find entries containing a transaction hash.

**`get_error_example`** — Get the example transaction stored for a given error.

**`search_errors`** — Return raw matching AI Search chunks without synthesized analysis.

**`decode_xdr`** — Decode base64-encoded Stellar XDR into JSON.

**`list_errors`** — List stored error/example objects in R2.

## Project structure

```
src/
  index.ts          Entry point, HTTP routing, cron orchestration
  stellar.ts        Ledger scanning, RPC client, transaction extraction
  analysis.ts       AI analysis prompts and model calls
  fingerprint.ts    SHA-256 fingerprinting, error signature extraction
  storage.ts        R2 / KV / Vectorize operations
  contracts.ts      On-chain contract spec fetching and caching
  mcp.ts            MCP server and tool definitions
  xdr.ts            Base64 XDR decoding utilities
  types.ts          TypeScript type definitions
```

## Configuration

Key constants in `src/index.ts`:

| Constant | Default | Description |
|---|---|---|
| `MAX_LEDGERS_PER_CYCLE` | 200 | Ledgers processed per cron trigger |
| `COLD_START_LOOKBACK` | 50 | Ledgers to look back on first run |

AI model and RPC endpoint are configured in `wrangler.jsonc` under `vars`.
