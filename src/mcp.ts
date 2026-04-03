import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types.js";
import {
  getErrorEntry,
  getExampleTransaction,
  findErrorEntryByTxHash,
} from "./storage.js";
import { buildAiSearchFilters } from "./ai-search.js";
import { sanitizeExampleTransaction } from "./jobs.js";
import { decodeXdr, decodeXdrWithType, guessXdrType } from "./xdr.js";

function createBaseServer(env: Env) {
  const server = new McpServer({
    name: "stellar-error-mcp",
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

        const answer = await (env.AI as any)
          .autorag(env.AI_SEARCH_INSTANCE)
          .aiSearch({
            query: queryText,
            model: env.AI_SEARCH_MODEL,
            rewrite_query: true,
            max_num_results: 5,
            ranking_options: { score_threshold: 0.3 },
            reranking: {
              enabled: true,
              model: "@cf/baai/bge-reranker-base",
            },
            filters: buildAiSearchFilters({
              contractId: contract_id,
              operationType: operation_type,
            }),
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
          const example = sanitizeExampleTransaction(
            await getExampleTransaction(env, fingerprint),
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ entry, example }, null, 2),
              },
            ],
          };
        }

        // Search by tx_hash across paginated error entries (batched reads)
        const foundEntry = await findErrorEntryByTxHash(env, tx_hash!);
        if (foundEntry) {
          const example = sanitizeExampleTransaction(
            await getExampleTransaction(env, foundEntry.fingerprint),
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ entry: foundEntry, example }, null, 2),
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

  // --- Tool: get_error_example ---
  server.tool(
    "get_error_example",
    "Retrieve the stored example transaction for a fingerprint, including the raw transaction JSON, the fully decoded transaction context, and the contract metadata snapshot used during analysis.",
    {
      fingerprint: z.string().describe("The error fingerprint hash"),
    },
    async ({ fingerprint }) => {
      try {
        const example = sanitizeExampleTransaction(
          await getExampleTransaction(env, fingerprint),
        );
        if (!example) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Example transaction for fingerprint ${fingerprint} not found.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(example, null, 2),
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
              text: `Error retrieving example transaction: ${message}`,
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
      fingerprint: z.string().optional().describe("Filter to a specific fingerprint"),
      contract_id: z.string().optional().describe("Filter to a primary contract"),
      function_name: z.string().optional().describe("Filter to a function name"),
      operation_type: z.string().optional().describe("Filter to a Soroban operation type"),
      error_category: z.string().optional().describe("Filter to an error category"),
      max_results: z
        .number()
        .optional()
        .default(10)
        .describe("Max results (1-50)"),
    },
    async ({
      query,
      fingerprint,
      contract_id,
      function_name,
      operation_type,
      error_category,
      max_results,
    }) => {
      try {
        const results = await (env.AI as any)
          .autorag(env.AI_SEARCH_INSTANCE)
          .search({
            query,
            max_num_results: Math.min(max_results ?? 10, 50),
            rewrite_query: true,
            filters: buildAiSearchFilters({
              fingerprint,
              contractId: contract_id,
              functionName: function_name,
              operationType: operation_type,
              errorCategory: error_category,
            }),
          });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                (results.data ?? []).map((d: any) => ({
                  filename: d.filename,
                  score: d.score,
                  attributes: d.attributes ?? null,
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

        // Let decodeXdrWithType iterate through types in preferred order
        const decoded = decodeXdrWithType(xdr_base64);
        if (!decoded) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Failed to decode XDR. Possible types: ${possibleTypes.join(", ")}.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `## Decoded as ${decoded.type}\n\nPossible types: ${possibleTypes.join(", ")}\n\n\`\`\`json\n${JSON.stringify(decoded.json, null, 2)}\n\`\`\``,
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
    "List deduplicated error entries stored in R2. Returns filenames, sizes, and upload dates.",
    {
      prefix: z
        .string()
        .optional()
        .default("search-docs/")
        .describe("File prefix ('search-docs/', 'errors/', 'examples/', or 'tx-index/')"),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Max files to list"),
    },
    async ({ prefix, limit }) => {
      try {
        const effectivePrefix = prefix ?? "search-docs/";
        const effectiveLimit = Math.min(limit ?? 100, 1000);

        const listed = await env.ERRORS_BUCKET.list({
          prefix: effectivePrefix,
          limit: effectiveLimit,
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
  return createMcpHandler(createBaseServer(env));
}
