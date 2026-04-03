import type { DirectErrorJob, DirectErrorSubmission, Env } from "./types.js";
import { createMcpFetchHandler } from "./mcp.js";
import { scanForFailedTransactions, getLatestLedger } from "./stellar.js";
import {
  getDirectErrorJob,
  getLastProcessedLedger,
  storeDirectErrorJob,
  setLastProcessedLedger,
} from "./storage.js";
import { SEARCH_DOCS_PREFIX } from "./ai-search.js";
import { parsePositiveInteger } from "./input.js";
import {
  buildFailedTransactionFromDirectError,
  buildQueuedDirectErrorJob,
  parseDirectErrorSubmission,
} from "./direct.js";
import { ingestFailedTransaction } from "./ingest.js";

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

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const suffix = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}${suffix}`;
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
  const configuredTokens = [
    env.MANAGEMENT_TOKEN?.trim(),
    env.MANAGEMENT_TOKEN_SECONDARY?.trim(),
  ].filter((value): value is string => !!value);
  const hostname = new URL(request.url).hostname;

  if (configuredTokens.length === 0) {
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
  const authorized = providedToken
    ? configuredTokens.some((token) => timingSafeEqual(providedToken, token))
    : false;
  if (!authorized) {
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

function isJobPathname(pathname: string): boolean {
  return pathname.startsWith("/jobs/") && !pathname.endsWith("/process");
}

function extractJobIdFromPathname(pathname: string): string {
  if (pathname.endsWith("/process")) {
    return pathname.slice("/jobs/".length, -"/process".length).trim();
  }
  return pathname.slice("/jobs/".length).trim();
}

function isJobStale(job: DirectErrorJob, thresholdMs = 30_000): boolean {
  const updatedAt = Date.parse(job.updatedAt);
  if (Number.isNaN(updatedAt)) return true;
  return Date.now() - updatedAt > thresholdMs;
}

function toPublicJob(job: DirectErrorJob): Omit<DirectErrorJob, "submission"> {
  const { submission: _submission, ...publicJob } = job;
  return publicJob;
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

async function updateJob(
  env: Env,
  job: DirectErrorJob,
  patch: Partial<DirectErrorJob>,
): Promise<DirectErrorJob> {
  const next: DirectErrorJob = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await storeDirectErrorJob(env, next);
  return next;
}

async function processDirectErrorJob(
  env: Env,
  job: DirectErrorJob,
  submission: DirectErrorSubmission,
): Promise<void> {
  try {
    const running = await updateJob(env, job, { status: "processing" });
    const failedTransaction = await buildFailedTransactionFromDirectError(submission);
    const result = await ingestFailedTransaction(env, failedTransaction);

    await updateJob(env, running, {
      status: "completed",
      sourceReference: failedTransaction.readout.sourceReference ?? failedTransaction.txHash,
      result: {
        duplicate: result.status === "duplicate",
        fingerprint: result.fingerprint,
        entry: result.entry,
        example: result.example,
      },
    });
  } catch (error) {
    await updateJob(env, job, {
      status: "failed",
      error: formatError(error),
    });
  }
}

async function processDirectErrorJobById(
  env: Env,
  jobId: string,
): Promise<DirectErrorJob> {
  const job = await getDirectErrorJob(env, jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found.`);
  }
  if (job.status === "completed" || job.status === "failed") {
    return job;
  }
  if (!job.submission) {
    throw new Error(`Job ${jobId} is missing its stored submission.`);
  }
  if (job.status === "processing" && !isJobStale(job)) {
    return job;
  }

  await processDirectErrorJob(env, job, job.submission);
  const refreshed = await getDirectErrorJob(env, jobId);
  if (!refreshed) {
    throw new Error(`Job ${jobId} disappeared after processing.`);
  }
  return refreshed;
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

  for (const tx of scanResult.transactions) {
    const result = await ingestFailedTransaction(env, tx);
    if (result.status === "duplicate") {
      duplicates++;
      continue;
    }
    newErrors++;
  }

  if (!opts.skipCursorUpdate) {
    await setLastProcessedLedger(env, scanResult.lastLedgerProcessed);
  }

  logInfo("scan.cycle_complete", {
    newErrors,
    duplicates,
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

    if (url.pathname === "/forward-error" && request.method === "POST") {
      const authError = requireManagementAccess(request, env);
      if (authError) return authError;

      try {
        const body = await parseJsonBody(request);
        const submission = parseDirectErrorSubmission(body);
        const jobId = randomId("job_");
        const job = buildQueuedDirectErrorJob(jobId, submission);
        await storeDirectErrorJob(env, job);

        return Response.json(
          {
            status: "accepted",
            jobId,
            pollUrl: `/jobs/${jobId}`,
          },
          { status: 202 },
        );
      } catch (error) {
        const message = formatError(error);
        logError("http.forward_error_failed", { error: message });
        return Response.json({ status: "error", message }, { status: 400 });
      }
    }

    if (url.pathname.startsWith("/jobs/") && request.method === "POST") {
      const authError = requireManagementAccess(request, env);
      if (authError) return authError;

      if (!url.pathname.endsWith("/process")) {
        return new Response("Not Found", { status: 404 });
      }

      const jobId = extractJobIdFromPathname(url.pathname);
      if (!jobId) {
        return Response.json(
          { status: "error", message: "Missing job id." },
          { status: 400 },
        );
      }

      try {
        const job = await processDirectErrorJobById(env, jobId);
        return Response.json({
          status: "ok",
          job: toPublicJob(job),
        });
      } catch (error) {
        const message = formatError(error);
        logError("http.job_process_failed", { jobId, error: message });
        return Response.json({ status: "error", message }, { status: 500 });
      }
    }

    if (isJobPathname(url.pathname) && request.method === "GET") {
      const authError = requireManagementAccess(request, env);
      if (authError) return authError;

      const jobId = extractJobIdFromPathname(url.pathname);
      if (!jobId) {
        return Response.json(
          { status: "error", message: "Missing job id." },
          { status: 400 },
        );
      }

      const job = await getDirectErrorJob(env, jobId);
      if (!job) {
        return Response.json(
          { status: "error", message: `Job ${jobId} not found.` },
          { status: 404 },
        );
      }

      if (job.status === "queued" || (job.status === "processing" && isJobStale(job))) {
        const processed = await processDirectErrorJobById(env, jobId);
        return Response.json(toPublicJob(processed));
      }

      return Response.json(toPublicJob(job));
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
          forwardError: "/forward-error",
          jobStatus: "/jobs/:jobId",
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
