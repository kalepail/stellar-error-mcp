import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import type { Env } from "./types.js";
import {
  getErrorEntry,
  getExampleTransaction,
  getRawTransaction,
  getAnalysis,
} from "./storage.js";
import { decodeXdr, guessXdrType } from "./xdr.js";

function createBaseServer(env: Env) {
  const server = new McpServer({
    name: "stellar-error-mpc",
    version: "1.0.0",
  });

  // --- Tool: diagnose_error ---
  server.tool(
    "diagnose_error",
    "Search the Stellar/Soroban failed transaction error knowledge base. Provide an error message, contract ID, error type, or description of the problem to find similar previously-analyzed failures and get an AI-powered diagnosis.",
    {
      error_message: z
        .string()
        .describe(
          "The error message, result kind, diagnostic output, description of the problem, OR a base64-encoded XDR blob (transaction envelope, result, etc.)",
        ),
      contract_id: z
        .string()
        .optional()
        .describe("The Stellar contract address if known"),
      operation_type: z
        .string()
        .optional()
        .describe(
          "The Soroban operation type (e.g., invoke_host_function, restore_footprint)",
        ),
    },
    async ({ error_message, contract_id, operation_type }) => {
      try {
        // If the input looks like base64 XDR, decode it first for a richer query
        let queryText = error_message;
        const isBase64 =
          error_message.length > 40 &&
          /^[A-Za-z0-9+/]+=*$/.test(error_message.trim());
        if (isBase64) {
          const decoded = decodeXdr(error_message.trim());
          if (decoded) {
            // Use the decoded JSON as the search query — much richer than raw base64
            queryText = JSON.stringify(decoded).slice(0, 2000);
          }
        }

        const queryParts = [queryText];
        if (contract_id) queryParts.push(`contract: ${contract_id}`);
        if (operation_type) queryParts.push(`operation: ${operation_type}`);
        const query = queryParts.join(" ");

        const answer = await (env.AI as any)
          .autorag(env.AI_SEARCH_INSTANCE)
          .aiSearch({
            query,
            model: env.AI_MODEL,
            rewrite_query: true,
            max_num_results: 5,
            ranking_options: { score_threshold: 0.3 },
            reranking: {
              enabled: true,
              model: "@cf/baai/bge-reranker-base",
            },
          });

        const response = answer.response ?? "No matching errors found.";
        const sources = (answer.data ?? [])
          .map(
            (d: any) =>
              `- ${d.filename} (score: ${d.score?.toFixed(2) ?? "?"})`,
          )
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `## Diagnosis\n\n${response}\n\n## Sources\n${sources || "No sources found"}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error searching knowledge base: ${message}`,
            },
          ],
        };
      }
    },
  );

  // --- Tool: get_error ---
  server.tool(
    "get_error",
    "Retrieve a deduplicated error entry by fingerprint hash, or look up which error a specific transaction hash belongs to.",
    {
      fingerprint: z
        .string()
        .optional()
        .describe("The error fingerprint hash"),
      tx_hash: z
        .string()
        .optional()
        .describe(
          "A transaction hash — will search for the error entry containing it",
        ),
    },
    async ({ fingerprint, tx_hash }) => {
      try {
        if (!fingerprint && !tx_hash) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Provide either a fingerprint or tx_hash.",
              },
            ],
          };
        }

        // Direct fingerprint lookup
        if (fingerprint) {
          const entry = await getErrorEntry(env, fingerprint);
          if (!entry) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error fingerprint ${fingerprint} not found.`,
                },
              ],
            };
          }
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(entry, null, 2) },
            ],
          };
        }

        // Search by tx_hash across error entries
        const listed = await env.ERRORS_BUCKET.list({
          prefix: "errors/",
          limit: 1000,
        });
        for (const obj of listed.objects) {
          const data = await env.ERRORS_BUCKET.get(obj.key);
          if (!data) continue;
          const entry: any = await data.json();
          if (
            Array.isArray(entry.txHashes) &&
            entry.txHashes.includes(tx_hash)
          ) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(entry, null, 2),
                },
              ],
            };
          }
        }

        // Fall back to legacy raw/ storage
        const raw = await getRawTransaction(env, tx_hash!);
        const analysis = await getAnalysis(env, tx_hash!);
        if (raw) {
          const result: Record<string, unknown> = {
            txHash: raw.txHash,
            resultKind: raw.resultKind,
            contractIds: raw.contractIds,
            readout: raw.readout,
          };
          if (analysis) {
            result.analysis = {
              summary: analysis.summary,
              errorCategory: analysis.errorCategory,
              likelyCause: analysis.likelyCause,
              suggestedFix: analysis.suggestedFix,
              confidence: analysis.confidence,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Transaction ${tx_hash} not found in the error database.`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error retrieving entry: ${message}`,
            },
          ],
        };
      }
    },
  );

  // --- Tool: search_errors ---
  // Raw chunk retrieval (no AI synthesis) — useful for Codemode
  server.tool(
    "search_errors",
    "Search the error knowledge base and return raw matching document chunks. Use diagnose_error for AI-powered answers instead.",
    {
      query: z.string().describe("Search query text"),
      max_results: z
        .number()
        .optional()
        .default(10)
        .describe("Max results (1-50)"),
    },
    async ({ query, max_results }) => {
      try {
        const results = await (env.AI as any)
          .autorag(env.AI_SEARCH_INSTANCE)
          .search({
            query,
            max_num_results: Math.min(max_results ?? 10, 50),
            rewrite_query: true,
          });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                (results.data ?? []).map((d: any) => ({
                  filename: d.filename,
                  score: d.score,
                  text: d.content?.[0]?.text ?? "",
                })),
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `Search error: ${message}` },
          ],
        };
      }
    },
  );

  // --- Tool: decode_xdr ---
  server.tool(
    "decode_xdr",
    "Decode a base64-encoded Stellar XDR blob into rich JSON. Can auto-detect the XDR type, or you can specify it. Useful for decoding transaction envelopes, results, meta, ledger entries, or any Stellar XDR.",
    {
      xdr_base64: z
        .string()
        .describe("The base64-encoded XDR to decode"),
      xdr_type: z
        .string()
        .optional()
        .describe(
          "The XDR type (e.g. TransactionEnvelope, TransactionResult, TransactionMeta, LedgerEntryData, ScVal). If omitted, the type will be guessed automatically.",
        ),
    },
    async ({ xdr_base64, xdr_type }) => {
      try {
        if (xdr_type) {
          const decoded = decodeXdr(xdr_base64, xdr_type);
          if (!decoded) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Failed to decode XDR as type "${xdr_type}". Try omitting xdr_type to auto-detect.`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `## Decoded as ${xdr_type}\n\n\`\`\`json\n${JSON.stringify(decoded, null, 2)}\n\`\`\``,
              },
            ],
          };
        }

        // Auto-detect type
        const possibleTypes = guessXdrType(xdr_base64);
        if (possibleTypes.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Could not determine the XDR type. The data may be malformed or not a recognized Stellar XDR type.",
              },
            ],
          };
        }

        // Prefer common transaction types
        const preferred = [
          "TransactionEnvelope",
          "TransactionResult",
          "TransactionMeta",
          "LedgerEntryData",
          "SorobanTransactionData",
          "LedgerKey",
          "DiagnosticEvent",
          "ScVal",
        ];
        const bestType =
          preferred.find((t) => possibleTypes.includes(t)) ??
          possibleTypes[0];

        const decoded = decodeXdr(xdr_base64, bestType);
        return {
          content: [
            {
              type: "text" as const,
              text: `## Decoded as ${bestType}\n\nPossible types: ${possibleTypes.join(", ")}\n\n\`\`\`json\n${JSON.stringify(decoded, null, 2)}\n\`\`\``,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `XDR decode error: ${message}` },
          ],
        };
      }
    },
  );

  // --- Tool: list_errors ---
  // List stored error files — useful for Codemode
  server.tool(
    "list_errors",
    "List deduplicated error entries stored in the R2 database. Returns filenames, sizes, and upload dates.",
    {
      prefix: z
        .string()
        .optional()
        .default("errors/")
        .describe("File prefix ('errors/', 'examples/', or legacy 'raw/')"),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Max files to list"),
    },
    async ({ prefix, limit }) => {
      try {
        const listed = await env.ERRORS_BUCKET.list({
          prefix: prefix ?? "errors/",
          limit: Math.min(limit ?? 100, 1000),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                listed.objects.map((obj) => ({
                  key: obj.key,
                  size: obj.size,
                  uploaded: obj.uploaded.toISOString(),
                })),
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `List error: ${message}`,
            },
          ],
        };
      }
    },
  );

  return server;
}

export async function createMcpFetchHandler(env: Env) {
  // McpServer is stateful per-connection, so create fresh per request
  const baseServer = createBaseServer(env);

  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    globalOutbound: null, // fully network-isolated sandbox
    timeout: 30000,
  });

  const server = await codeMcpServer({
    server: baseServer,
    executor,
  });

  return createMcpHandler(server);
}
