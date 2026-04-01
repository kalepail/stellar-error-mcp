# stellar-error-mpc

A Cloudflare Worker that continuously scans the Stellar blockchain for failed Soroban transactions, deduplicates and analyzes them with AI, and exposes the resulting error knowledge base via a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server.

## How it works

1. **Scan** — Every 5 minutes, fetches recent ledgers from the Stellar Archive RPC and extracts failed Soroban transactions (invoke, restore, extend operations).
2. **Fingerprint** — Computes a SHA-256 fingerprint from contracts, function name, error signatures, and result kind. Duplicate errors increment a counter instead of being re-analyzed.
3. **Semantic dedup** — New errors are embedded with `bge-base-en-v1.5` and checked against a Vectorize index. Similar errors (score >= 0.90) are linked together.
4. **Decode and enrich** — Each failed transaction is normalized into a first-class decoded artifact containing the raw envelope/processing JSON, recursively XDR-decoded views, invoke/auth/resource summaries, operation-level effects, ledger changes, and touched contract IDs.
5. **Analyze** — Unique errors are sent to a Cloudflare AI model with the full enriched transaction plus contract specs and decoded WASM custom sections, encoded as TOON for high-fidelity LLM input. The model returns a structured analysis: summary, evidence-based classification, likely cause, suggested fix, related codes, debug steps, detailed analysis, and confidence level.
6. **Store** — Error entries, enriched example transactions, and contract metadata snapshots are persisted to R2. Vectors are indexed in Vectorize. Documents are indexed in AI Search.
7. **Serve** — An MCP server exposes tools (`diagnose_error`, `get_error`, `get_error_example`, `decode_xdr`) so AI agents can query the knowledge base with natural language or raw XDR blobs.

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

## Development

```bash
npm run dev         # local dev server with cron test mode
npm run types       # generate Cloudflare Worker types
```

Trigger a scan manually:

```bash
curl -X POST http://localhost:8787/trigger
```

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

**`get_error`** — Retrieve a specific error entry by fingerprint or find entries containing a transaction hash. Returns the error entry together with the stored example transaction record when available.

**`get_error_example`** — Get the stored example transaction record for a fingerprint, including the raw transaction JSON, decoded transaction context, and contract metadata snapshot used during analysis.

**`decode_xdr`** — Decode arbitrary base64 XDR blobs into rich JSON with automatic type guessing.

## Project structure

```
src/
  index.ts          Entry point, HTTP routing, cron orchestration
  stellar.ts        Ledger scanning, RPC client, transaction extraction
  transaction.ts    Shared transaction decoding and normalization helpers
  analysis.ts       AI analysis prompts and model calls
  fingerprint.ts    SHA-256 fingerprinting, error signature extraction
  storage.ts        R2 / KV / Vectorize operations
  contracts.ts      On-chain contract spec and WASM custom section fetching/caching
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
