import type { AsyncJob, Env, LedgerRangeWorkflowInput } from "./types.js";
import { createMcpFetchHandler } from "./mcp.js";
import { parsePositiveInteger } from "./input.js";
import { parseDirectErrorSubmission } from "./direct.js";
import {
  createInitialJob,
  createJobId,
  isTerminalJobStatus,
  preflightDirectErrorSubmission,
  updateJob,
  workflowStatusToAsyncStatus,
  buildDirectWorkflowInput,
} from "./jobs.js";
import {
  cleanupRetainedJobArtifacts,
  getActiveDirectJob,
  getActiveRecurringScanRecord,
  getAsyncJob,
  getLastProcessedLedger,
  setActiveDirectJob,
  setActiveRecurringScanRecord,
  storeAsyncJob,
  storeJobInput,
  storeStagedFailedTransaction,
} from "./storage.js";
import {
  DirectErrorWorkflow,
  LedgerRangeWorkflow,
  syncJobWithWorkflowStatus,
} from "./workflows.js";

const MANAGEMENT_TOKEN_HEADER = "x-management-token";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logError(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "error", event, ...fields }));
}

function logInfo(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
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

function isWorkflowInstanceMissing(error: unknown): boolean {
  const message = formatError(error);
  return message.includes("instance.not_found");
}

function getManagementTokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const [scheme, ...rest] = authorization.split(/\s+/);
    if (scheme && rest.length > 0 && scheme.toLowerCase() === "bearer") {
      return rest.join(" ").trim();
    }
  }

  return request.headers.get(MANAGEMENT_TOKEN_HEADER)?.trim() || null;
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
  return /^\/jobs\/[^/]+$/.test(pathname);
}

function extractJobIdFromPathname(pathname: string): string {
  return pathname.slice("/jobs/".length).trim();
}

function isAdminTerminateJobPathname(pathname: string): boolean {
  return /^\/admin\/jobs\/[^/]+\/terminate$/.test(pathname);
}

function extractAdminTerminateJobId(pathname: string): string {
  return pathname.slice("/admin/jobs/".length, -"/terminate".length).trim();
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function acceptedJobResponse(
  request: Request,
  job: AsyncJob,
  extras: Record<string, unknown> = {},
): Response {
  const pollUrl = new URL(`/jobs/${job.jobId}`, request.url).pathname;
  return Response.json(
    {
      status: "accepted",
      duplicate: false,
      jobId: job.jobId,
      pollUrl,
      ...extras,
    },
    {
      status: 202,
      headers: {
        Location: pollUrl,
        "Retry-After": "5",
      },
    },
  );
}

async function createDirectErrorJob(
  env: Env,
  preflight: Extract<
    Awaited<ReturnType<typeof preflightDirectErrorSubmission>>,
    { duplicate: false }
  >,
): Promise<AsyncJob> {
  const jobId = createJobId("direct_error");
  const stagedTransactionKey = await storeStagedFailedTransaction(
    env,
    jobId,
    preflight.transaction.txHash,
    preflight.transaction,
  );
  const job = createInitialJob(
    jobId,
    "direct_error",
    "accepted",
    { completed: 0, total: 4, unit: "steps", message: "Direct error accepted." },
    preflight.sourceReference,
  );

  await storeAsyncJob(env, job);
  await storeJobInput(
    env,
    jobId,
    buildDirectWorkflowInput(
      jobId,
      preflight.sourceReference,
      stagedTransactionKey,
      preflight.transaction.txHash,
    ),
  );
  await setActiveDirectJob(env, preflight.transaction.txHash, jobId);

  const instance = await env.DIRECT_ERROR_WORKFLOW.create({
    id: jobId,
    params: { jobId },
  });
  const details = await instance.status();

  const next = updateJob(job, {
    workflowStatus: details.status,
    status: workflowStatusToAsyncStatus(details.status),
  });
  await storeAsyncJob(env, next);
  return next;
}

async function createOrReuseDirectErrorJob(
  env: Env,
  preflight: Extract<
    Awaited<ReturnType<typeof preflightDirectErrorSubmission>>,
    { duplicate: false }
  >,
): Promise<{ job: AsyncJob; reused: boolean }> {
  const activeJobId = await getActiveDirectJob(env, preflight.transaction.txHash);
  if (activeJobId) {
    const current = await getAsyncJob(env, activeJobId);
    if (current) {
      const synced = await syncJobWithWorkflowStatus(env, current);
      if (!isTerminalJobStatus(synced.status)) {
        return { job: synced, reused: true };
      }
    }
    await setActiveDirectJob(env, preflight.transaction.txHash, null);
  }

  const job = await createDirectErrorJob(env, preflight);
  return { job, reused: false };
}

async function createLedgerRangeJob(
  env: Env,
  input: LedgerRangeWorkflowInput,
): Promise<AsyncJob> {
  const job = createInitialJob(
    input.jobId,
    input.kind,
    "accepted",
    { completed: 0, unit: "ledgers", message: "Ledger job accepted." },
  );

  await storeAsyncJob(env, job);
  await storeJobInput(env, input.jobId, input);

  const instance = await env.LEDGER_RANGE_WORKFLOW.create({
    id: input.jobId,
    params: { jobId: input.jobId },
  });
  const details = await instance.status();

  const next = updateJob(job, {
    workflowStatus: details.status,
    status: workflowStatusToAsyncStatus(details.status),
  });
  await storeAsyncJob(env, next);

  if (input.kind === "recurring_scan") {
    await setActiveRecurringScanRecord(env, {
      jobId: input.jobId,
      updatedAt: next.updatedAt,
    });
  }

  return next;
}

async function startOrReuseRecurringScanJob(
  env: Env,
  initiatedBy: string,
): Promise<{ job: AsyncJob; reused: boolean }> {
  const active = await getActiveRecurringScanRecord(env);
  if (active?.jobId) {
    const current = await getAsyncJob(env, active.jobId);
    if (current) {
      try {
        const synced = await syncJobWithWorkflowStatus(env, current);
        if (!isTerminalJobStatus(synced.status)) {
          return { job: synced, reused: true };
        }
      } catch (error) {
        if (!isWorkflowInstanceMissing(error)) {
          throw error;
        }
      }
    }
    await setActiveRecurringScanRecord(env, null);
  }

  const input: LedgerRangeWorkflowInput = {
    jobId: createJobId("recurring_scan"),
    kind: "recurring_scan",
    mode: "recurring",
    updateCursor: true,
    initiatedBy,
  };
  const job = await createLedgerRangeJob(env, input);
  return { job, reused: false };
}

async function getJobStatus(env: Env, jobId: string): Promise<AsyncJob | null> {
  const existing = await getAsyncJob(env, jobId);
  if (existing) {
    if (isTerminalJobStatus(existing.status) && existing.workflowStatus) {
      return existing;
    }
    try {
      return await syncJobWithWorkflowStatus(env, existing);
    } catch (error) {
      logError("job.sync_status_failed", {
        jobId,
        storedStatus: existing.status,
        storedPhase: existing.phase,
        error: formatError(error),
      });
      return existing;
    }
  }
  return null;
}

function buildBatchInput(url: URL): LedgerRangeWorkflowInput | Response {
  const hours = parsePositiveInteger(url.searchParams.get("hours"));
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");

  if (startParam && endParam) {
    const startLedger = parsePositiveInteger(startParam);
    const endLedger = parsePositiveInteger(endParam);
    if (startLedger === null || endLedger === null || endLedger <= startLedger) {
      return Response.json(
        { error: "Provide numeric start/end values with end > start." },
        { status: 400 },
      );
    }
    return {
      jobId: createJobId("ledger_batch"),
      kind: "ledger_batch",
      mode: "batch",
      startLedger,
      endLedger,
      updateCursor: false,
      initiatedBy: "http:batch",
    };
  }

  if (hours !== null) {
    return {
      jobId: createJobId("ledger_batch"),
      kind: "ledger_batch",
      mode: "batch",
      hours,
      updateCursor: false,
      initiatedBy: "http:batch",
    };
  }

  return Response.json(
    { error: "Provide ?hours=N or ?start=N&end=N" },
    { status: 400 },
  );
}

export { DirectErrorWorkflow, LedgerRangeWorkflow };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp")) {
      const handler = await createMcpFetchHandler(env);
      return handler(request, env, ctx);
    }

    if (url.pathname === "/forward-error" && request.method === "POST") {
      const authError = requireManagementAccess(request, env);
      if (authError) return authError;

      try {
        const body = await parseJsonBody(request);
        const submission = parseDirectErrorSubmission(body);
        const preflight = await preflightDirectErrorSubmission(env, submission);

        if (preflight.duplicate) {
          return Response.json({
            status: "duplicate",
            duplicate: true,
            sourceReference: preflight.sourceReference,
            fingerprint: preflight.fingerprint,
            entry: preflight.entry,
            example: preflight.example,
          });
        }

        const { job, reused } = await createOrReuseDirectErrorJob(env, preflight);
        return acceptedJobResponse(request, job, {
          sourceReference: preflight.sourceReference,
          reused,
        });
      } catch (error) {
        const message = formatError(error);
        logError("http.forward_error_failed", { error: message });
        return Response.json({ status: "error", message }, { status: 400 });
      }
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      const authError = requireManagementAccess(request, env);
      if (authError) return authError;

      try {
        const { job, reused } = await startOrReuseRecurringScanJob(env, "http:trigger");
        return acceptedJobResponse(request, job, { reused });
      } catch (error) {
        const message = formatError(error);
        logError("http.trigger_failed", { error: message });
        return Response.json({ status: "error", message }, { status: 500 });
      }
    }

    if (url.pathname === "/batch" && request.method === "POST") {
      const authError = requireManagementAccess(request, env);
      if (authError) return authError;

      const input = buildBatchInput(url);
      if (input instanceof Response) return input;

      try {
        const job = await createLedgerRangeJob(env, input);
        return acceptedJobResponse(request, job);
      } catch (error) {
        const message = formatError(error);
        logError("http.batch_failed", { error: message });
        return Response.json({ status: "error", message }, { status: 500 });
      }
    }

    if (isAdminTerminateJobPathname(url.pathname) && request.method === "POST") {
      const authError = requireManagementAccess(request, env);
      if (authError) return authError;

      const jobId = extractAdminTerminateJobId(url.pathname);
      const job = await getAsyncJob(env, jobId);
      if (!job) {
        return Response.json(
          { status: "error", message: `Job ${jobId} not found.` },
          { status: 404 },
        );
      }

      try {
        const binding = job.kind === "direct_error"
          ? env.DIRECT_ERROR_WORKFLOW
          : env.LEDGER_RANGE_WORKFLOW;
        const instance = await binding.get(jobId);
        await instance.terminate();

        const next = updateJob(job, {
          status: "failed",
          phase: "failed",
          workflowStatus: "terminated",
          error: "Terminated by management endpoint.",
        });
        await storeAsyncJob(env, next);

        if (job.kind === "recurring_scan") {
          await setActiveRecurringScanRecord(env, null);
        }

        return Response.json({ status: "ok", job: next });
      } catch (error) {
        const message = formatError(error);
        logError("http.job_terminate_failed", { jobId, error: message });
        return Response.json({ status: "error", message }, { status: 500 });
      }
    }

    if (isJobPathname(url.pathname) && request.method === "GET") {
      const jobId = extractJobIdFromPathname(url.pathname);
      if (!jobId) {
        return Response.json(
          { status: "error", message: "Missing job id." },
          { status: 400 },
        );
      }

      try {
        const job = await getJobStatus(env, jobId);
        if (!job) {
          return Response.json(
            { status: "error", message: `Job ${jobId} not found.` },
            { status: 404 },
          );
        }
        return Response.json(job);
      } catch (error) {
        const message = formatError(error);
        logError("http.job_status_failed", { jobId, error: message });
        return Response.json({ status: "error", message }, { status: 500 });
      }
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      const lastLedger = await getLastProcessedLedger(env);
      return Response.json({
        service: "stellar-error-mcp",
        status: "ok",
        lastProcessedLedger: lastLedger,
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      startOrReuseRecurringScanJob(env, "cron")
        .then(({ job, reused }) => {
          logInfo("scheduled.recurring_scan_job", {
            jobId: job.jobId,
            reused,
          });
        })
        .catch((error) => {
          logError("scheduled.recurring_scan_failed", {
            error: formatError(error),
          });
        }),
    );
    ctx.waitUntil(
      cleanupRetainedJobArtifacts(env)
        .then(({ deletedJobs, deletedArtifacts }) => {
          if (deletedJobs === 0 && deletedArtifacts === 0) return;
          logInfo("scheduled.workflow_artifact_cleanup", {
            deletedJobs,
            deletedArtifacts,
          });
        })
        .catch((error) => {
          logError("scheduled.workflow_artifact_cleanup_failed", {
            error: formatError(error),
          });
        }),
    );
  },
};
