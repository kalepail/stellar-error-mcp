import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers.js";
import {
  getAsyncJob,
  setActiveDirectJob,
  storeAsyncJob,
  storeJobInput,
  storeStagedFailedTransaction,
} from "../src/storage.js";
import {
  buildDirectWorkflowInput,
  createInitialJob,
  createJobId,
  preflightDirectErrorSubmission,
} from "../src/jobs.js";
import { parseDirectErrorSubmission } from "../src/direct.js";

vi.mock("../src/xdr.js", () => ({
  deepDecodeXdr: (value: unknown) => value,
}));

interface RealSimulationFixture {
  kind: "rpc_simulate";
  sourceLabel: string;
  transactionXdr: string;
  response: {
    error: string;
    events: string[];
    latestLedger: number;
  };
}

function loadFixture(): RealSimulationFixture {
  const raw = readFileSync(
    new URL("./fixtures/real-rpc-sim-auth-error.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(raw) as RealSimulationFixture;
}

function loadFixtureAt(path: string): RealSimulationFixture {
  const raw = readFileSync(new URL(path, import.meta.url), "utf8");
  return JSON.parse(raw) as RealSimulationFixture;
}

function createStepRecorder() {
  const names: string[] = [];
  return {
    names,
    step: {
      do: async (
        name: string,
        configOrCallback: unknown,
        maybeCallback?: (ctx: { attempt: number }) => Promise<unknown>,
      ) => {
        names.push(name);
        const callback = typeof configOrCallback === "function"
          ? configOrCallback as (ctx: { attempt: number }) => Promise<unknown>
          : maybeCallback!;
        return callback({ attempt: 1 });
      },
      sleep: async () => undefined,
      sleepUntil: async () => undefined,
      waitForEvent: async () => ({
        payload: {},
        timestamp: new Date(),
        type: "test",
      }),
    } as WorkflowStep,
  };
}

describe("real simulation direct-workflow smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes a real captured rpc_simulate failure through preflight, storage, workflow, and final job state", async () => {
    const fixture = loadFixture();
    const env = createTestEnv();
    env.STELLAR_RPC_ENDPOINT = "http://127.0.0.1:9";
    env.STELLAR_ARCHIVE_RPC_ENDPOINT = "http://127.0.0.1:9";
    let capturedPrompt = "";

    env.AI = {
      run: vi.fn(async (model: string, params: any) => {
        if (model === "@cf/baai/bge-base-en-v1.5") {
          void params;
          return { data: [[0.1, 0.2, 0.3]] };
        }
        capturedPrompt = params.messages[1].content as string;
        return JSON.stringify({
          summary: "Smart-account auth failed before token transfer execution.",
          errorCategory: "host:Auth.InvalidAction",
          likelyCause: "The custom account contract rejected the transfer auth context while executing __check_auth.",
          suggestedFix: "Inspect the smart account rule or signer payload used for this transfer.",
          detailedAnalysis: "The simulation reached the account contract auth path and trapped before the SAC transfer could complete.",
          evidence: [
            "Simulation error headline is HostError: Error(Auth, InvalidAction).",
            "Diagnostic events include __check_auth and UnreachableCodeReached.",
          ],
          relatedCodes: [
            "Error(Auth, InvalidAction)",
            "Error(WasmVm, InvalidAction)",
            "__check_auth",
          ],
          debugSteps: [
            "Verify the signer payload matches the account contract expectations.",
            "Check the auth rule that authorizes the transfer action.",
          ],
          confidence: "high",
        });
      }),
    } as unknown as Ai;

    const submission = parseDirectErrorSubmission({
      ...fixture,
      forceReanalyze: true,
    });
    const preflight = await preflightDirectErrorSubmission(env, submission);
    expect(preflight.duplicate).toBe(false);

    if (preflight.duplicate) {
      throw new Error("Smoke fixture unexpectedly deduplicated.");
    }

    const jobId = createJobId("direct_error");
    const stagedTransactionKey = await storeStagedFailedTransaction(
      env,
      jobId,
      preflight.transaction.txHash,
      preflight.transaction,
    );
    await storeAsyncJob(
      env,
      createInitialJob(
        jobId,
        "direct_error",
        "accepted",
        { completed: 0, total: 4, unit: "steps", message: "Direct error accepted." },
        preflight.sourceReference,
      ),
    );
    await storeJobInput(
      env,
      jobId,
      buildDirectWorkflowInput(
        jobId,
        preflight.sourceReference,
        stagedTransactionKey,
        preflight.transaction.txHash,
        true,
      ),
    );
    await setActiveDirectJob(env, preflight.transaction.txHash, jobId);

    const { DirectErrorWorkflow } = await import("../src/workflows.js");
    const workflow = new DirectErrorWorkflow(
      { waitUntil: () => undefined } as ExecutionContext,
      env,
    );
    const recorder = createStepRecorder();

    await workflow.run(
      {
        payload: { jobId },
        timestamp: new Date(),
        instanceId: jobId,
      },
      recorder.step,
    );

    expect(recorder.names).toContain("load-input");
    expect(recorder.names).toContain("load-staged-transaction");
    expect(recorder.names).toContain("ingest-direct-error");
    expect(recorder.names).toContain("finalize-direct-job");

    const job = await getAsyncJob(env, jobId);
    expect(job).toMatchObject({
      status: "completed",
      phase: "completed",
      workflowStatus: "complete",
    });

    expect(job?.result?.fingerprint).toEqual(expect.any(String));
    expect(job?.result?.entry.functionName).toBe("transfer");
    expect(job?.result?.entry.resultKind).toBe("simulate:hosterror_error_auth_invalidaction");
    expect(job?.result?.entry.sorobanOperationTypes).toContain("invoke_host_function");
    expect(job?.result?.entry.contractIds).toEqual(
      expect.arrayContaining([
        "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        "CBQVIRSH6EMJVR4SBEMUOZ3ZFFYI6FTQW7DMNESA2BB2XOVYG24FX47T",
      ]),
    );
    expect(job?.result?.entry.errorCategory).toBe("host:Auth.InvalidAction");
    expect(job?.result?.example?.transaction.observationKind).toBe("rpc_simulate");
    expect(job?.result?.example?.transaction.readout.simulationError).toContain(
      "HostError: Error(Auth, InvalidAction)",
    );

    expect(capturedPrompt).toContain("HostError: Error(Auth, InvalidAction)");
    expect(capturedPrompt).toContain("__check_auth");
    expect(capturedPrompt).toContain("rpc_simulate");
  });

  it("processes the execute-wrapper testnet auth failure through the same direct workflow path", async () => {
    const fixture = loadFixtureAt("./fixtures/real-rpc-sim-execute-auth-error.json");
    const env = createTestEnv();
    env.STELLAR_RPC_ENDPOINT = "http://127.0.0.1:9";
    env.STELLAR_ARCHIVE_RPC_ENDPOINT = "http://127.0.0.1:9";
    let capturedPrompt = "";

    env.AI = {
      run: vi.fn(async (model: string, params: any) => {
        if (model === "@cf/baai/bge-base-en-v1.5") {
          void params;
          return { data: [[0.1, 0.2, 0.3]] };
        }
        capturedPrompt = params.messages[1].content as string;
        return JSON.stringify({
          summary: "The smart-account execute wrapper failed during require_auth before the transfer completed.",
          errorCategory: "host:Auth.InvalidAction",
          likelyCause: "The account contract rejected the execute/transfer auth context.",
          suggestedFix: "Inspect execute authorization rules and WebAuthn signer payload handling.",
          detailedAnalysis: "The simulation hit execute, then __check_auth, then trapped in the auth path.",
          evidence: [
            "Diagnostic events include execute and __check_auth.",
            "The simulation escalates require_auth into a VM trap.",
          ],
          relatedCodes: [
            "Error(Auth, InvalidAction)",
            "Error(WasmVm, InvalidAction)",
            "require_auth",
            "__check_auth",
          ],
          debugSteps: [
            "Confirm the execute action is allowed by rule 0.",
            "Verify the WebAuthn challenge/signature payload is valid for this auth path.",
          ],
          confidence: "high",
        });
      }),
    } as unknown as Ai;

    const submission = parseDirectErrorSubmission({
      ...fixture,
      forceReanalyze: true,
    });
    const preflight = await preflightDirectErrorSubmission(env, submission);
    expect(preflight.duplicate).toBe(false);
    if (preflight.duplicate) throw new Error("Smoke fixture unexpectedly deduplicated.");

    const jobId = createJobId("direct_error");
    const stagedTransactionKey = await storeStagedFailedTransaction(
      env,
      jobId,
      preflight.transaction.txHash,
      preflight.transaction,
    );
    await storeAsyncJob(
      env,
      createInitialJob(
        jobId,
        "direct_error",
        "accepted",
        { completed: 0, total: 4, unit: "steps", message: "Direct error accepted." },
        preflight.sourceReference,
      ),
    );
    await storeJobInput(
      env,
      jobId,
      buildDirectWorkflowInput(
        jobId,
        preflight.sourceReference,
        stagedTransactionKey,
        preflight.transaction.txHash,
        true,
      ),
    );
    await setActiveDirectJob(env, preflight.transaction.txHash, jobId);

    const { DirectErrorWorkflow } = await import("../src/workflows.js");
    const workflow = new DirectErrorWorkflow(
      { waitUntil: () => undefined } as ExecutionContext,
      env,
    );

    await workflow.run(
      {
        payload: { jobId },
        timestamp: new Date(),
        instanceId: jobId,
      },
      createStepRecorder().step,
    );

    const job = await getAsyncJob(env, jobId);
    expect(job).toMatchObject({
      status: "completed",
      phase: "completed",
      workflowStatus: "complete",
    });
    expect(job?.result?.entry.functionName).toBe("execute");
    expect(job?.result?.entry.resultKind).toBe("simulate:hosterror_error_auth_invalidaction");
    expect(job?.result?.entry.errorCategory).toBe("host:Auth.InvalidAction");
    expect(job?.result?.entry.contractIds).toEqual(
      expect.arrayContaining([
        "CBQVIRSH6EMJVR4SBEMUOZ3ZFFYI6FTQW7DMNESA2BB2XOVYG24FX47T",
        "CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU",
      ]),
    );
    expect(job?.result?.example?.transaction.readout.simulationError).toContain("require_auth");
    expect(capturedPrompt).toContain("execute");
    expect(capturedPrompt).toContain("require_auth");
    expect(capturedPrompt).toContain("__check_auth");
  });
});
