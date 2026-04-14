# stellar-error-mcp

`stellar-error-mcp` is a Cloudflare Worker that turns failed Soroban transactions into a searchable error knowledge base. It ingests failures from scheduled ledger scans or direct RPC submissions, enriches them with contract and transaction context, analyzes them with Cloudflare AI, and serves the results through HTTP endpoints and a Model Context Protocol (MCP) server.

## What The App Does

This service is built to answer three developer questions after a Soroban failure:

- what failed
- why it likely failed
- what to try next

For each failed transaction it can:

- normalize the raw RPC payload into a consistent internal record
- decode XDR and extract contracts, functions, operations, and error signatures
- deduplicate exact and near-duplicate failures
- fetch contract metadata and WASM custom-section details
- generate a structured diagnosis with evidence and suggested fixes
- store the corpus in R2, KV, Vectorize, and AI Search
- expose the knowledge base to agents over MCP

## Processing Flow

1. **Collect**: scan recent ledgers or accept a direct `sendTransaction` / `simulateTransaction` failure.
2. **Normalize**: convert the failure into a first-class transaction artifact.
3. **Fingerprint**: hash the failure shape for exact deduplication.
4. **Deduplicate semantically**: compare embeddings in Vectorize to group similar failures.
5. **Enrich**: decode the transaction, summarize auth/resource data, and fetch contract metadata.
6. **Analyze**: ask Cloudflare AI for a structured diagnosis.
7. **Store**: persist canonical errors, reference transactions, workflow artifacts, and search documents.
8. **Serve**: make the results available over HTTP and MCP tools.

## Main Components

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Worker entrypoint, routing, cron handling |
| `src/workflows.ts` | Workflow orchestration for direct errors and ledger scans |
| `src/jobs.ts` | Job lifecycle, preflight duplicate handling, public job status |
| `src/direct.ts` | Parsing and normalization for direct RPC failures |
| `src/stellar.ts` | Ledger scanning and Stellar RPC access |
| `src/transaction.ts` | Transaction decoding and metadata extraction |
| `src/contracts.ts` | Contract metadata and WASM custom-section retrieval |
| `src/analysis.ts` | AI prompts and structured diagnosis generation |
| `src/storage.ts` | R2, KV, Vectorize, and AI Search persistence |
| `src/mcp.ts` | MCP server and tool definitions |

## Cloudflare Resources

Provision these before deploying:

| Resource | Expected Binding / Name |
| --- | --- |
| R2 bucket | `stellar-errors` |
| R2 bucket | `stellar-error-runtime` |
| KV namespace | bound as `CURSOR_KV` |
| Vectorize index | `stellar-error-fingerprints` |
| AI Search instance | `stellar-errors` |
| Workflows | `stellar-error-direct`, `stellar-error-ledger-range` |

The committed `wrangler.jsonc` uses concrete resource names and IDs. Replace them with resources from your own Cloudflare account if you deploy this elsewhere.

## Local Setup

Install dependencies:

```bash
npm install
```

Create a `.dev.vars` file:

```bash
STELLAR_ARCHIVE_RPC_TOKEN=your_archive_rpc_token
```

Optional overrides:

```bash
STELLAR_RPC_ENDPOINT=https://rpc-pro.lightsail.network
STELLAR_RPC_AUTH_MODE=header

STELLAR_TESTNET_RPC_ENDPOINT=https://your-testnet-rpc.example.com
STELLAR_TESTNET_ARCHIVE_RPC_ENDPOINT=https://your-testnet-archive-rpc.example.com
STELLAR_TESTNET_RPC_TOKEN=optional_testnet_token
STELLAR_TESTNET_RPC_AUTH_MODE=header

AI_ANALYSIS_TIMEOUT_MS=3600000
AI_ANALYSIS_MAX_DURATION_MS=3600000
```

For deployed management endpoints:

```bash
wrangler secret put MANAGEMENT_TOKEN
```

## Development

```bash
npm run dev
npm run types
npm run check
npm test
```

Trigger the recurring scanner locally:

```bash
curl -X POST http://localhost:8787/trigger
```

Submit a direct RPC error:

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
      "errorResultXdr": "AAAA..."
    }
  }'
```

If the failure is new, the API returns a job ID you can poll:

```bash
curl http://localhost:8787/jobs/de_<id>
```

## HTTP Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Service status and last processed ledger |
| `POST` | `/trigger` | Start or reuse the recurring scan workflow |
| `POST` | `/batch?hours=24` | Queue a recent backfill |
| `POST` | `/batch?start=N&end=M` | Queue a ledger-range backfill |
| `POST` | `/forward-error` | Ingest a direct failed RPC response |
| `GET` | `/jobs/:jobId` | Poll a workflow-backed async job |
| `POST` | `/mcp` | MCP protocol endpoint |

## MCP Tools

The MCP server exposes:

- `diagnose_error`
- `get_error`
- `get_error_example`
- `decode_xdr`
- `search_errors`

These tools let agents search the corpus, fetch stored examples, and decode raw XDR payloads without going through the Cloudflare dashboard.

## AI Search Provisioning

The repo includes `scripts/provision-ai-search.mjs` to create or update the AI Search instance from code.

Example:

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_AI_SEARCH_TOKEN_ID=...
npm run provision:ai-search
```

If you are already authenticated with `wrangler login`, the script can reuse the Wrangler auth token automatically. You can also override that with `CLOUDFLARE_AI_SEARCH_API_TOKEN`.

## Testing

Run the unit and integration tests with:

```bash
npm test
```

There is also an opt-in live RPC capture suite:

```bash
export STELLAR_ARCHIVE_RPC_TOKEN=...
export STELLAR_RPC_ENDPOINT=https://rpc-pro.lightsail.network
export STELLAR_RPC_AUTH_MODE=header
npm run test:live-rpc
```

Live observations are written under `.context/live-rpc-observations/` and are intentionally ignored by git.

## Storage Layout

- `errors/<fingerprint>.json`: canonical error records
- `reference-transactions/<fingerprint>.json`: stored example transactions and contract metadata
- `jobs/<jobId>.json`: public job snapshots
- `job-inputs/<jobId>.json`: workflow input payloads
- `job-results/<jobId>.json`: larger result artifacts
- `job-staging/<jobId>/...`: staged workflow artifacts
- `search-docs/<fingerprint>.md`: AI Search source documents
- KV `tx:<txHash>`: hash-to-fingerprint pointers

## License

This project is licensed under Apache 2.0. See [LICENSE](./LICENSE).
