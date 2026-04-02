import type { ContractMetadata, Env, ErrorEntry } from "./types.js";
import { createMcpFetchHandler } from "./mcp.js";
import { scanForFailedTransactions, getLatestLedger } from "./stellar.js";
import {
  getErrorEntry,
  storeErrorEntry,
  bumpErrorEntry,
  storeExampleTransaction,
  findSimilarError,
  indexErrorVector,
  getLastProcessedLedger,
  setLastProcessedLedger,
} from "./storage.js";
import { analyzeFailedTransaction } from "./analysis.js";
import {
  buildFingerprint,
  buildErrorDescription,
} from "./fingerprint.js";
import {
  fetchContractsForError,
  buildContractContext,
} from "./contracts.js";

const MAX_LEDGERS_PER_CYCLE = 200;
const COLD_START_LOOKBACK = 50;
const MANAGEMENT_TOKEN_HEADER = "x-management-token";

interface ProcessOptions {
  maxLedgers?: number;
  startOverride?: number;
  maxFailed?: number;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let mismatch = aBytes.length === bBytes.length ? 0 : 1;
  const len = Math.max(aBytes.length, bBytes.length);

  for (let i = 0; i < len; i++) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }

  return mismatch === 0;
}

function getManagementTokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const [scheme, ...rest] = authorization.split(/\s+/);
    if (scheme && rest.length > 0 && scheme.toLowerCase() === "bearer") {
      return rest.join(" ").trim();
    }
  }

  const headerToken = request.headers.get(MANAGEMENT_TOKEN_HEADER)?.trim();
  return headerToken || null;
}

function requireManagementAccess(
  request: Request,
  env: Env,
): Response | null {
  const configuredToken = env.MANAGEMENT_TOKEN?.trim();
  const hostname = new URL(request.url).hostname;

  if (!configuredToken) {
    if (isLoopbackHostname(hostname)) return null;
    return Response.json(
      {
        status: "error",
        message:
          "Management endpoints are disabled until MANAGEMENT_TOKEN is configured.",
      },
      { status: 503 },
    );
  }

  const providedToken = getManagementTokenFromRequest(request);
  if (!providedToken || !timingSafeEqual(providedToken, configuredToken)) {
    return Response.json(
      {
        status: "error",
        message:
          "Unauthorized. Provide a valid Bearer token or x-management-token header.",
      },
      { status: 401 },
    );
  }

  return null;
}

function parsePositiveInteger(
  rawValue: string | null,
): number | null {
  if (!rawValue) return null;
  const value = Number.parseInt(rawValue, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function processNewLedgers(
  env: Env,
  opts: ProcessOptions = {},
): Promise<void> {
  const maxLedgers = opts.maxLedgers ?? MAX_LEDGERS_PER_CYCLE;
  let startLedger = opts.startOverride ?? (await getLastProcessedLedger(env));

  if (startLedger === null) {
    const latest = await getLatestLedger(env);
    startLedger = latest - COLD_START_LOOKBACK;
    console.log(
      `Cold start: latest ledger ${latest}, starting from ${startLedger}`,
    );
  } else if (!opts.startOverride) {
    startLedger += 1;
  }

  console.log(`Scanning from ledger ${startLedger} (max ${maxLedgers} ledgers)...`);

  const scanResult = await scanForFailedTransactions(
    env,
    startLedger,
    maxLedgers,
    opts.maxFailed,
  );

  console.log(
    `Scanned ${scanResult.ledgersScanned} ledgers (${scanResult.pagesScanned} pages), found ${scanResult.transactions.length} failed Soroban txs`,
  );

  let newErrors = 0;
  let duplicates = 0;
  let similarLinks = 0;

  for (const tx of scanResult.transactions) {
    const { fingerprint, functionName, errorSignatures } =
      await buildFingerprint(tx);

    // --- Layer 1: Structural fingerprint (exact match) ---
    const existing = await getErrorEntry(env, fingerprint);

    if (existing) {
      await bumpErrorEntry(env, existing, tx.txHash, tx.ledgerCloseTime);
      duplicates++;
      console.log(
        `Duplicate #${existing.seenCount}: ${fingerprint.slice(0, 12)}... (${tx.txHash.slice(0, 12)}...)`,
      );
      continue;
    }

    // --- Layer 2: Vector similarity (semantic match) ---
    const descriptionContracts = tx.primaryContractIds.length > 0
      ? tx.primaryContractIds
      : tx.contractIds;
    const description = buildErrorDescription(
      descriptionContracts,
      functionName,
      errorSignatures,
      tx.resultKind,
    );

    let similarTo: string | undefined;
    try {
      const similar = await findSimilarError(env, description);
      if (similar) {
        similarTo = similar.fingerprint;
        similarLinks++;
        console.log(
          `Semantically similar (${similar.score.toFixed(3)}): ${fingerprint.slice(0, 12)}... ≈ ${similar.fingerprint.slice(0, 12)}...`,
        );
      }
    } catch (error) {
      // Vectorize may not be available in local dev — proceed without it
      console.log(
        `Vector similarity check skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // --- Fetch contract specs for context ---
    let contracts: Map<string, ContractMetadata> | undefined;
    let contractContext: string | undefined;
    if (tx.contractIds.length > 0) {
      try {
        contracts = await fetchContractsForError(env, tx.contractIds);
        contractContext = buildContractContext(contracts);
      } catch (error) {
        console.log(
          `Contract fetch skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // --- New error: analyze with AI (including contract specs) ---
    const analysis = await analyzeFailedTransaction(env, tx, contracts);

    const entry: ErrorEntry = {
      fingerprint,
      contractIds: tx.contractIds,
      functionName,
      errorSignatures,
      resultKind: tx.resultKind,
      sorobanOperationTypes: tx.sorobanOperationTypes,
      summary: analysis.summary,
      errorCategory: analysis.errorCategory,
      likelyCause: analysis.likelyCause,
      suggestedFix: analysis.suggestedFix,
      detailedAnalysis: analysis.detailedAnalysis,
      evidence: analysis.evidence,
      relatedCodes: analysis.relatedCodes,
      debugSteps: analysis.debugSteps,
      confidence: analysis.confidence,
      modelId: analysis.modelId,
      seenCount: 1,
      txHashes: [tx.txHash],
      firstSeen: tx.ledgerCloseTime,
      lastSeen: tx.ledgerCloseTime,
      similarTo,
      exampleTxHash: tx.txHash,
      exampleReadout: tx.readout,
      contractContext: contractContext ?? undefined,
    };

    await storeErrorEntry(env, entry);
    await storeExampleTransaction(
      env,
      tx,
      fingerprint,
      contracts ? [...contracts.values()] : [],
    );

    // Index in Vectorize for future similarity checks
    try {
      await indexErrorVector(env, fingerprint, description, {
        errorCategory: entry.errorCategory,
        functionName,
        contractIds: tx.contractIds.join(",").slice(0, 200),
        relatedCodes: entry.relatedCodes.join(",").slice(0, 200),
      });
    } catch (error) {
      console.log(
        `Vector indexing skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    newErrors++;
    console.log(
      `New error ${fingerprint.slice(0, 12)}...: ${tx.resultKind} → ${entry.errorCategory} (${entry.confidence})${similarTo ? ` [similar to ${similarTo.slice(0, 12)}...]` : ""}`,
    );
  }

  await setLastProcessedLedger(env, scanResult.lastLedgerProcessed);

  console.log(
    `Cycle complete: ${newErrors} new, ${duplicates} duplicates, ${similarLinks} similar links, cursor at ledger ${scanResult.lastLedgerProcessed}`,
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // MCP endpoint
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp")) {
      const handler = await createMcpFetchHandler(env);
      return handler(request, env, ctx);
    }

    // Manual trigger for testing the cron pipeline
    if (url.pathname === "/trigger" && request.method === "POST") {
      const authError = requireManagementAccess(request, env);
      if (authError) return authError;

      try {
        await processNewLedgers(env);
        const lastLedger = await getLastProcessedLedger(env);
        return Response.json({ status: "ok", lastProcessedLedger: lastLedger });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Error while handling /trigger request:", error);
        return Response.json({ status: "error", message }, { status: 500 });
      }
    }

    // Batch processing — scan a large range of ledgers
    // POST /batch?hours=24 or POST /batch?start=61905000&end=61922000
    if (url.pathname === "/batch" && request.method === "POST") {
      const authError = requireManagementAccess(request, env);
      if (authError) return authError;

      const hours = parsePositiveInteger(url.searchParams.get("hours"));
      const startParam = url.searchParams.get("start");
      const endParam = url.searchParams.get("end");

      let batchStart: number;
      let batchEnd: number;

      if (startParam && endParam) {
        const parsedStart = parsePositiveInteger(startParam);
        const parsedEnd = parsePositiveInteger(endParam);
        if (parsedStart === null || parsedEnd === null || parsedEnd <= parsedStart) {
          return Response.json(
            { error: "Provide numeric start/end values with end > start." },
            { status: 400 },
          );
        }
        batchStart = parsedStart;
        batchEnd = parsedEnd;
      } else if (hours !== null) {
        batchEnd = await getLatestLedger(env);
        batchStart = batchEnd - Math.floor((hours * 3600) / 5);
      } else {
        return Response.json(
          { error: "Provide ?hours=N or ?start=N&end=N" },
          { status: 400 },
        );
      }

      const totalLedgers = batchEnd - batchStart;
      const CHUNK_SIZE = 200;

      // Stream progress as NDJSON
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      const write = async (data: Record<string, unknown>) => {
        await writer.write(encoder.encode(JSON.stringify(data) + "\n"));
      };

      ctx.waitUntil(
        (async () => {
          try {
            await write({
              event: "start",
              batchStart,
              batchEnd,
              totalLedgers,
            });

            let cursor = batchStart;

            while (cursor < batchEnd) {
              const chunkLedgers = Math.min(CHUNK_SIZE, batchEnd - cursor);
              try {
                await processNewLedgers(env, {
                  startOverride: cursor,
                  maxLedgers: chunkLedgers,
                  maxFailed: 100,
                });
              } catch (error) {
                const msg =
                  error instanceof Error ? error.message : String(error);
                await write({ event: "chunk_error", cursor, error: msg });
              }

              cursor += chunkLedgers;
              const progress = (
                ((cursor - batchStart) / totalLedgers) *
                100
              ).toFixed(1);
              await write({
                event: "progress",
                cursor,
                progress: `${progress}%`,
              });
            }

            await write({
              event: "done",
              lastLedger: await getLastProcessedLedger(env),
            });
          } catch (error) {
            const msg =
              error instanceof Error ? error.message : String(error);
            await write({ event: "fatal", error: msg });
          } finally {
            await writer.close();
          }
        })(),
      );

      return new Response(readable, {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Transfer-Encoding": "chunked",
        },
      });
    }

    // Ingest stub for future manual ingest
    if (url.pathname === "/ingest" && request.method === "POST") {
      return Response.json(
        { status: "not_implemented", message: "Manual ingest coming soon" },
        { status: 501 },
      );
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      const lastLedger = await getLastProcessedLedger(env);
      return Response.json({
        service: "stellar-error-mcp",
        status: "ok",
        lastProcessedLedger: lastLedger,
        endpoints: {
          mcp: "/mcp",
          ingest: "/ingest (POST, coming soon)",
          health: "/health",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(processNewLedgers(env));
  },
} satisfies ExportedHandler<Env>;
