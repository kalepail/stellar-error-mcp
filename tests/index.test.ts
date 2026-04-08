import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers.js";
import {
  setActiveDirectJob,
  setActiveRecurringScanRecord,
  storeAsyncJob,
} from "../src/storage.js";
import type { AsyncJob } from "../src/types.js";

const { preflightDirectErrorSubmission, syncJobWithWorkflowStatus } = vi.hoisted(() => ({
  preflightDirectErrorSubmission: vi.fn(),
  syncJobWithWorkflowStatus: vi.fn(async (_env: unknown, job: unknown) => job),
}));

vi.mock("../src/mcp.js", () => ({
  createMcpFetchHandler: async () => () => new Response("mock mcp"),
}));

vi.mock("../src/direct.js", () => ({
  parseDirectErrorSubmission: (value: unknown) => value,
}));

vi.mock("../src/workflows.js", () => ({
  DirectErrorWorkflow: class {},
  LedgerRangeWorkflow: class {},
  syncJobWithWorkflowStatus,
}));

vi.mock("../src/jobs.js", async () => {
  return {
    createInitialJob: (
      jobId: string,
      kind: string,
      phase: string,
      progress: unknown,
      sourceReference?: string,
    ) => ({
      jobId,
      kind,
      status: "queued",
      phase,
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      progress,
      sourceReference,
    }),
    createJobId: (kind: string) =>
      kind === "direct_error"
        ? "de_generated"
        : kind === "ledger_batch"
        ? "lb_generated"
        : "rs_generated",
    isTerminalJobStatus: (status: string) =>
      status === "completed" || status === "failed",
    preflightDirectErrorSubmission,
    sanitizeErrorEntry: (entry: Record<string, unknown>) => entry,
    sanitizeExampleTransaction: (example: unknown) => example,
    updateJob: (job: Record<string, unknown>, patch: Record<string, unknown>) => ({
      ...job,
      ...patch,
      updatedAt: "2026-04-02T00:01:00.000Z",
    }),
    workflowStatusToAsyncStatus: (status: string) =>
      status === "complete"
        ? "completed"
        : status === "errored"
        ? "failed"
        : status === "running"
        ? "running"
        : "queued",
    buildDirectWorkflowInput: (
      jobId: string,
      sourceReference: string,
      stagedTransactionKey: string,
      txHash: string,
    ) => ({
      jobId,
      sourceReference,
      stagedTransactionKey,
      txHash,
    }),
  };
});

describe("worker fetch routes", () => {
  beforeEach(() => {
    preflightDirectErrorSubmission.mockReset();
    syncJobWithWorkflowStatus.mockReset();
    syncJobWithWorkflowStatus.mockImplementation(async (_env: unknown, job: unknown) => job);
  });

  it("serves a health document aligned with the workflow architecture", async () => {
    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("https://example.com/health"),
      createTestEnv(),
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      service: "stellar-error-mcp",
      status: "ok",
    });
  });

  it("returns a degraded health document when cursor storage is unavailable", async () => {
    const env = createTestEnv();
    env.CURSOR_KV.get = vi.fn(async () => {
      throw new Error("KV GET failed: 400 Bad Request");
    }) as any;

    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("https://example.com/health"),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      service: "stellar-error-mcp",
      status: "degraded",
      lastProcessedLedger: null,
      error: "KV GET failed: 400 Bad Request",
    });
  });

  it("returns an inline duplicate response without creating a workflow", async () => {
    preflightDirectErrorSubmission.mockResolvedValue({
      duplicate: true,
      sourceReference: "rpcsim-1",
      fingerprint: "fp-1",
      entry: { fingerprint: "fp-1", summary: "duplicate" },
      example: null,
    });

    const env = createTestEnv();
    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("http://localhost/forward-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "rpc_simulate",
          transactionXdr: "AAAA",
          response: { error: "boom" },
        }),
      }),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "duplicate",
      duplicate: true,
      fingerprint: "fp-1",
    });
    expect(env.DIRECT_ERROR_WORKFLOW.created).toHaveLength(0);
  });

  it("creates a workflow-backed direct job and returns polling headers", async () => {
    preflightDirectErrorSubmission.mockResolvedValue({
      duplicate: false,
      transaction: { txHash: "tx-1" },
      fingerprint: "fp-new",
      sourceReference: "rpcsend-1",
    });

    const env = createTestEnv();
    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("http://localhost/forward-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "rpc_send",
          transactionXdr: "AAAA",
          response: { status: "ERROR" },
        }),
      }),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toMatch(/^\/jobs\/de_/);
    expect(response.headers.get("Retry-After")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({
      status: "accepted",
      duplicate: false,
      sourceReference: "rpcsend-1",
      jobId: expect.stringMatching(/^de_/),
    });
    expect(env.DIRECT_ERROR_WORKFLOW.created).toHaveLength(1);
  });

  it("forwards forceReanalyze submissions into direct-error preflight", async () => {
    preflightDirectErrorSubmission.mockResolvedValue({
      duplicate: false,
      transaction: { txHash: "tx-force" },
      fingerprint: "fp-force",
      sourceReference: "rpcsend-force",
      forceReanalyze: true,
    });

    const env = createTestEnv();
    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("http://localhost/forward-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "rpc_send",
          transactionXdr: "AAAA",
          response: { status: "ERROR" },
          forceReanalyze: true,
        }),
      }),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    expect(preflightDirectErrorSubmission).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ forceReanalyze: true }),
    );
  });

  it("reuses an active direct error job for the same tx hash", async () => {
    preflightDirectErrorSubmission.mockResolvedValue({
      duplicate: false,
      transaction: { txHash: "tx-inflight" },
      fingerprint: "fp-new",
      sourceReference: "rpcsend-1",
    });

    const env = createTestEnv();
    const job: AsyncJob = {
      jobId: "de_inflight",
      kind: "direct_error",
      status: "running",
      phase: "analyzing",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:01:00.000Z",
      progress: { completed: 3, total: 4, unit: "steps" },
      sourceReference: "rpcsend-1",
      workflowStatus: "running",
    };
    await storeAsyncJob(env, job);
    await setActiveDirectJob(env, "tx-inflight", job.jobId);

    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("http://localhost/forward-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "rpc_send",
          transactionXdr: "AAAA",
          response: { status: "ERROR" },
        }),
      }),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "de_inflight",
      reused: true,
    });
    expect(env.DIRECT_ERROR_WORKFLOW.created).toHaveLength(0);
  });

  it("does not reuse an active direct error job when forceReanalyze is set", async () => {
    preflightDirectErrorSubmission.mockResolvedValue({
      duplicate: false,
      transaction: { txHash: "tx-inflight-force" },
      fingerprint: "fp-force",
      sourceReference: "rpcsend-force",
      forceReanalyze: true,
    });

    const env = createTestEnv();
    const job: AsyncJob = {
      jobId: "de_inflight_force",
      kind: "direct_error",
      status: "running",
      phase: "analyzing",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:01:00.000Z",
      progress: { completed: 3, total: 4, unit: "steps" },
      sourceReference: "rpcsend-force",
      workflowStatus: "running",
    };
    await storeAsyncJob(env, job);
    await setActiveDirectJob(env, "tx-inflight-force", job.jobId);

    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("http://localhost/forward-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "rpc_send",
          transactionXdr: "AAAA",
          response: { status: "ERROR" },
          forceReanalyze: true,
        }),
      }),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "de_generated",
      reused: false,
    });
    expect(env.DIRECT_ERROR_WORKFLOW.created).toHaveLength(1);
  });

  it("serves public job status without exposing stored submission input", async () => {
    const env = createTestEnv();
    const job: AsyncJob = {
      jobId: "de_publicjob",
      kind: "direct_error",
      status: "completed",
      phase: "completed",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:01:00.000Z",
      progress: { completed: 4, total: 4, unit: "steps" },
      sourceReference: "rpcsend-1",
      workflowStatus: "complete",
      result: {
        duplicate: false,
        fingerprint: "fp-1",
        entry: { fingerprint: "fp-1", summary: "summary" } as never,
        example: null,
      },
    };
    await storeAsyncJob(env, job);

    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("https://example.com/jobs/de_publicjob"),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, unknown>;
    expect(json.jobId).toBe("de_publicjob");
    expect(json.kind).toBe("direct_error");
    expect(json).not.toHaveProperty("submission");
  });

  it("falls back to the stored job snapshot when workflow status sync throws", async () => {
    const env = createTestEnv();
    const job: AsyncJob = {
      jobId: "lb_syncfallback",
      kind: "ledger_batch",
      status: "queued",
      phase: "accepted",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:01:00.000Z",
      progress: { completed: 0, unit: "ledgers" },
      workflowStatus: "queued",
    };
    await storeAsyncJob(env, job);
    syncJobWithWorkflowStatus.mockRejectedValueOnce(new Error("workflow backend unavailable"));

    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("https://example.com/jobs/lb_syncfallback"),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "lb_syncfallback",
      status: "queued",
      phase: "accepted",
      workflowStatus: "queued",
    });
  });

  it("returns a degraded workflow snapshot when job storage lookup fails", async () => {
    const env = createTestEnv();
    env.DIRECT_ERROR_WORKFLOW.setStatus("de_degraded", { status: "running" });
    const originalGet = env.WORKFLOW_ARTIFACTS_BUCKET.get.bind(env.WORKFLOW_ARTIFACTS_BUCKET);
    env.WORKFLOW_ARTIFACTS_BUCKET.get = vi.fn(async (key: string) => {
      if (key === "jobs/de_degraded.json") {
        throw new Error("get: Unspecified error (0)");
      }
      return originalGet(key);
    }) as any;

    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("https://example.com/jobs/de_degraded"),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "de_degraded",
      status: "degraded",
      workflowStatus: "running",
      message: "get: Unspecified error (0)",
    });
  });

  it("does not synthesize a public job when the snapshot is missing", async () => {
    const env = createTestEnv();
    env.DIRECT_ERROR_WORKFLOW.setStatus("de_orphaned", { status: "running" });

    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("https://example.com/jobs/de_orphaned"),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(404);
  });

  it("reuses an active recurring scan job", async () => {
    const env = createTestEnv();
    const job: AsyncJob = {
      jobId: "rs_activejob",
      kind: "recurring_scan",
      status: "running",
      phase: "scanning",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:01:00.000Z",
      progress: { completed: 5, total: 200, unit: "ledgers" },
      workflowStatus: "running",
    };
    await storeAsyncJob(env, job);
    await setActiveRecurringScanRecord(env, {
      jobId: job.jobId,
      updatedAt: job.updatedAt,
    });
    env.LEDGER_RANGE_WORKFLOW.setStatus(job.jobId, { status: "running" });

    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("http://localhost/trigger", { method: "POST" }),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "rs_activejob",
      reused: true,
    });
    expect(env.LEDGER_RANGE_WORKFLOW.created).toHaveLength(0);
  });

  it("clears a stale recurring scan record when workflow lookup says instance.not_found", async () => {
    const env = createTestEnv();
    const job: AsyncJob = {
      jobId: "rs_stalejob",
      kind: "recurring_scan",
      status: "running",
      phase: "scanning",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:01:00.000Z",
      progress: { completed: 5, total: 200, unit: "ledgers" },
      workflowStatus: "running",
    };
    await storeAsyncJob(env, job);
    await setActiveRecurringScanRecord(env, {
      jobId: job.jobId,
      updatedAt: job.updatedAt,
    });
    syncJobWithWorkflowStatus.mockRejectedValueOnce(new Error("instance.not_found"));

    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("http://localhost/trigger", { method: "POST" }),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "rs_generated",
      reused: false,
    });
    expect(env.LEDGER_RANGE_WORKFLOW.created).toHaveLength(1);
  });

  it("creates a batch workflow job", async () => {
    const env = createTestEnv();
    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("http://localhost/batch?start=10&end=20", { method: "POST" }),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: expect.stringMatching(/^lb_/),
      status: "accepted",
    });
    expect(env.LEDGER_RANGE_WORKFLOW.created).toHaveLength(1);
  });

  it("terminates a running recurring scan job via the management endpoint", async () => {
    const env = createTestEnv();
    const job: AsyncJob = {
      jobId: "rs_terminate",
      kind: "recurring_scan",
      status: "running",
      phase: "scanning",
      createdAt: "2026-04-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:01:00.000Z",
      progress: { completed: 10, total: 200, unit: "ledgers" },
      workflowStatus: "running",
    };
    await storeAsyncJob(env, job);
    await setActiveRecurringScanRecord(env, {
      jobId: job.jobId,
      updatedAt: job.updatedAt,
    });

    const { default: worker } = await import("../src/index.js");
    const response = await worker.fetch(
      new Request("https://example.com/admin/jobs/rs_terminate/terminate", {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
      }),
      { ...env, MANAGEMENT_TOKEN: "test-token" },
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      job: {
        jobId: "rs_terminate",
        workflowStatus: "terminated",
        status: "failed",
      },
    });
    await expect(env.CURSOR_KV.get("active_recurring_scan_job")).resolves.toBeNull();
  });
});
