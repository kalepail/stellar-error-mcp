import type { ContractMetadata, Env, ErrorEntry } from "./types.js";
import { createMcpFetchHandler } from "./mcp.js";
import { scanForFailedTransactions, getLatestLedger } from "./stellar.js";
import {
  getErrorEntry,
  storeErrorEntry,
  bumpErrorEntry,
  storeTxHashPointer,
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
import { SEARCH_DOCS_PREFIX } from "./ai-search.js";
import { attachDeepDecodedViews } from "./transaction.js";
import { parsePositiveInteger } from "./input.js";

const MAX_LEDGERS_PER_CYCLE = 200;
const COLD_START_LOOKBACK = 50;
const MANAGEMENT_TOKEN_HEADER = "x-management-token";

interface ProcessOptions {
  maxLedgers?: number;
  startOverride?: number;
  maxFailed?: number;
  skipCursorUpdate?: boolean;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logInfo(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

function logWarn(event: string, fields: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
}

function logError(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "error", event, ...fields }));
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

async function processNewLedgers(
  env: Env,
  opts: ProcessOptions = {},
): Promise<void> {
  const maxLedgers = opts.maxLedgers ?? MAX_LEDGERS_PER_CYCLE;
  let startLedger = opts.startOverride ?? (await getLastProcessedLedger(env));

  if (startLedger === null) {
    const latest = await getLatestLedger(env);
    startLedger = latest - COLD_START_LOOKBACK;
    logInfo("scan.cold_start", { latestLedger: latest, startLedger });
  } else if (!opts.startOverride) {
    startLedger += 1;
  }

  logInfo("scan.start", {
    startLedger,
    maxLedgers,
    maxFailed: opts.maxFailed ?? null,
  });

  const scanResult = await scanForFailedTransactions(
    env,
    startLedger,
    maxLedgers,
    opts.maxFailed,
  );

  logInfo("scan.complete_fetch", {
    ledgersScanned: scanResult.ledgersScanned,
    pagesScanned: scanResult.pagesScanned,
    failedTransactions: scanResult.transactions.length,
  });

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
      logInfo("scan.duplicate", {
        fingerprint,
        txHash: tx.txHash,
        seenCount: existing.seenCount + 1,
      });
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
        logInfo("scan.similar_match", {
          fingerprint,
          similarTo: similar.fingerprint,
          score: Number(similar.score.toFixed(3)),
        });
      }
    } catch (error) {
      logWarn("scan.similarity_skipped", { error: formatError(error) });
    }

    // --- Fetch contract specs for context ---
    let contracts: Map<string, ContractMetadata> | undefined;
    let contractContext: string | undefined;
    if (tx.contractIds.length > 0) {
      try {
        contracts = await fetchContractsForError(env, tx.contractIds);
        contractContext = buildContractContext(contracts);
      } catch (error) {
        logWarn("scan.contract_fetch_skipped", {
          txHash: tx.txHash,
          error: formatError(error),
        });
      }
    }

    const enrichedTx = {
      ...tx,
      decoded: attachDeepDecodedViews(
        tx.decoded,
        tx.envelopeJson,
        tx.processingJson,
      ),
    };

    // --- New error: analyze with AI (including contract specs) ---
    const analysis = await analyzeFailedTransaction(env, enrichedTx, contracts);

    const entry: ErrorEntry = {
      fingerprint,
      contractIds: enrichedTx.contractIds,
      functionName,
      errorSignatures,
      resultKind: enrichedTx.resultKind,
      sorobanOperationTypes: enrichedTx.sorobanOperationTypes,
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
      txHashes: [enrichedTx.txHash],
      firstSeen: enrichedTx.ledgerCloseTime,
      lastSeen: enrichedTx.ledgerCloseTime,
      similarTo,
      exampleTxHash: enrichedTx.txHash,
      exampleReadout: enrichedTx.readout,
      contractContext: contractContext ?? undefined,
    };

    await storeErrorEntry(env, entry);
    await storeTxHashPointer(env, enrichedTx.txHash, fingerprint);
    await storeExampleTransaction(
      env,
      enrichedTx,
      fingerprint,
      contracts ? [...contracts.values()] : [],
    );

    // Index in Vectorize for future similarity checks
    try {
      await indexErrorVector(env, fingerprint, description, {
        errorCategory: entry.errorCategory,
        functionName,
        contractIds: enrichedTx.contractIds.join(",").slice(0, 200),
        relatedCodes: entry.relatedCodes.join(",").slice(0, 200),
      });
    } catch (error) {
      logWarn("scan.vector_index_skipped", {
        fingerprint,
        error: formatError(error),
      });
    }

    newErrors++;
    logInfo("scan.new_error", {
      fingerprint,
      txHash: tx.txHash,
      resultKind: tx.resultKind,
      errorCategory: entry.errorCategory,
      confidence: entry.confidence,
      similarTo: similarTo ?? null,
    });
  }

  if (!opts.skipCursorUpdate) {
    await setLastProcessedLedger(env, scanResult.lastLedgerProcessed);
  }

  logInfo("scan.cycle_complete", {
    newErrors,
    duplicates,
    similarLinks,
    lastLedgerProcessed: scanResult.lastLedgerProcessed,
  });
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
        const message = formatError(error);
        logError("http.trigger_failed", { error: message });
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
                  skipCursorUpdate: true,
                });
              } catch (error) {
                const msg = formatError(error);
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
            const msg = formatError(error);
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

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      const lastLedger = await getLastProcessedLedger(env);
      return Response.json({
        service: "stellar-error-mcp",
        status: "ok",
        lastProcessedLedger: lastLedger,
        aiSearch: {
          instance: env.AI_SEARCH_INSTANCE,
          searchablePrefix: SEARCH_DOCS_PREFIX,
        },
        endpoints: {
          mcp: "/mcp",
          trigger: "/trigger",
          batch: "/batch",
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
