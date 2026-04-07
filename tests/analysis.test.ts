import { describe, expect, it, vi } from "vitest";
import { analyzeFailedTransaction } from "../src/analysis.js";
import { createTestEnv } from "./helpers.js";
import type { ContractMetadata, FailedTransaction } from "../src/types.js";

function createFailedTx(overrides: Partial<FailedTransaction> = {}): FailedTransaction {
  return {
    observationKind: "rpc_send",
    txHash: "tx-analysis-1",
    ledgerSequence: 123,
    ledgerCloseTime: "2026-04-03T12:00:00.000Z",
    resultKind: "tx_bad_auth",
    soroban: true,
    primaryContractIds: ["C1"],
    contractIds: ["C1", "C2"],
    operationTypes: ["invoke_host_function"],
    sorobanOperationTypes: ["invoke_host_function"],
    diagnosticEvents: [],
    envelopeJson: { envelope: { body: "small" } },
    processingJson: { result: { tx_bad_auth: true } },
    decoded: {
      topLevelFunction: "transfer",
      errorSignatures: [{ type: "auth", code: "invalid_action" }],
      invokeCalls: [{ contractId: "C1", functionName: "transfer", args: [1, 2] }],
      authEntries: [{ address: "GABC" }],
      resourceLimits: { instructions: 1000, readBytes: 100, writeBytes: 20 },
      transactionResult: { tx_bad_auth: {} },
      sorobanMeta: { events: [] },
      contractEvents: [{ type: "contract" }],
      diagnosticEvents: [{ type: "diagnostic" }],
      envelopeOperations: [{ body: { invoke_host_function: true } }],
      processingOperations: [{ index: 0, changeCount: 0, eventCount: 0, diagnosticEventCount: 1, touchedContractIds: ["C1"], changes: [], events: [], diagnosticEvents: [] }],
      ledgerChanges: [{ operationIndex: 0, contractIds: ["C1"], change: { after: "value" } }],
      touchedContractIds: ["C1", "C2"],
      decodedEnvelope: { decoded: { body: "small" } },
      decodedProcessing: { decoded: { processing: "small" } },
    },
    readout: {
      observationKind: "rpc_send",
      resultKind: "tx_bad_auth",
      feeBump: false,
      invokeCallCount: 1,
      contractCount: 2,
      hasSorobanMeta: true,
      hasEvents: true,
      hasDiagnosticEvents: true,
    },
    ...overrides,
  };
}

function createContractMetadata(): Map<string, ContractMetadata> {
  return new Map([
    [
      "C1",
      {
        contractId: "C1",
        wasmHash: "wasm-1",
        builtin: {
          kind: "stellar_asset_contract",
          name: "Stellar Asset Contract",
          summary: "Built-in token contract for Stellar assets.",
          sourceRefs: [
            {
              label: "SAC Host Implementation",
              url: "https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/builtin_contracts/stellar_asset_contract/contract.rs",
            },
          ],
          authSemantics: ["Getters require no authorization."],
          failureModes: ["Missing trustlines on classic accounts map to TrustlineMissingError."],
          detectionReason: "Detected from contractExecutableStellarAsset on-ledger executable type.",
        },
        contractType: "stellar_asset",
        functions: [
          {
            name: "transfer",
            inputs: [
              { name: "from", type: "Address" },
              { name: "to", type: "Address" },
              { name: "amount", type: "i128" },
            ],
            outputs: ["void"],
          },
        ],
        errorEnums: [
          {
            name: "Error",
            cases: [{ name: "InsufficientBalance", value: 1 }],
          },
        ],
        structs: [{ name: "Transfer", fields: [{ name: "amount", type: "i128" }] }],
        customSections: {
          contractspecv0: [{ type: "spec" }],
          contractmetav0: [{ key: "doc", value: "metadata" }],
          contractenvmetav0: [{ key: "env", value: "testnet" }],
        },
        fetchedAt: "2026-04-03T12:00:00.000Z",
        notes: ["Built-in Stellar Asset Contract executable"],
        assetMetadata: {
          decimal: 7,
          name: "native",
          symbol: "native",
        },
      },
    ],
  ]);
}

describe("analysis prompt building", () => {
  it("keeps full high-fidelity context when the prompt fits the budget", async () => {
    const env = createTestEnv();
    let capturedPrompt = "";
    let capturedParams: any;
    let capturedOptions: any;
    env.AI = {
      run: vi.fn(async (_model, params: any, options: any) => {
        capturedParams = params;
        capturedOptions = options;
        capturedPrompt = params.messages[1].content;
        return JSON.stringify({
          summary: "summary",
          errorCategory: "auth:invalid_action",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["tx_bad_auth"],
          debugSteps: ["step"],
          confidence: "high",
        });
      }),
    } as unknown as Ai;

    const result = await analyzeFailedTransaction(
      env,
      createFailedTx(),
      createContractMetadata(),
    );

    expect(result.errorCategory).toBe("auth:invalid_action");
    expect(capturedPrompt).toContain("```toon");
    expect(capturedPrompt).toContain("raw:");
    expect(capturedPrompt).toContain("decoded:");
    expect(capturedPrompt).toContain("customSections:");
    expect(capturedPrompt).toContain("builtinInsights[");
    expect(capturedPrompt).toContain("stellar_asset_contract");
    expect(capturedPrompt).toContain("\t");
    expect(capturedParams.max_completion_tokens).toBe(8192);
    expect(capturedParams.temperature).toBe(0.1);
    expect(capturedParams.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(capturedParams.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "stellar_error_analysis",
        strict: true,
      },
    });
    expect(capturedOptions).toEqual({
      headers: {
        "x-session-affinity": "stellar-error:tx-analysis-1",
      },
    });
  });

  it("accepts structured JSON object responses from response_format mode", async () => {
    const env = createTestEnv();
    env.AI = {
      run: vi.fn(async () => ({
        response: {
          summary: "summary",
          errorCategory: "auth:invalid_action",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["Error(Auth, InvalidAction)"],
          debugSteps: ["step"],
          confidence: "high",
        },
      })),
    } as unknown as Ai;

    const result = await analyzeFailedTransaction(
      env,
      createFailedTx(),
      createContractMetadata(),
    );

    expect(result.errorCategory).toBe("auth:invalid_action");
    expect(result.summary).toBe("summary");
  });

  it("drops duplicate low-value sections and summarizes contract blobs when the prompt is oversized", async () => {
    const env = createTestEnv();
    let capturedPrompt = "";
    const huge = "x".repeat(70000);
    env.AI = {
      run: vi.fn(async (_model, params: any) => {
        capturedPrompt = params.messages[1].content;
        return JSON.stringify({
          summary: "summary",
          errorCategory: "auth:invalid_action",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["tx_bad_auth"],
          debugSteps: ["step"],
          confidence: "high",
        });
      }),
    } as unknown as Ai;

    await analyzeFailedTransaction(
      env,
      createFailedTx({
        envelopeJson: { envelope: huge },
        processingJson: { processing: huge },
        decoded: {
          ...createFailedTx().decoded,
          decodedEnvelope: { decodedEnvelope: huge },
          decodedProcessing: { decodedProcessing: huge },
          diagnosticEvents: Array.from({ length: 250 }, (_, index) => ({
            type: "diagnostic",
            index,
            message: huge,
          })),
        },
      }),
      createContractMetadata(),
    );

    expect(capturedPrompt).toContain("```toon");
    expect(capturedPrompt).not.toContain("raw:");
    expect(capturedPrompt).not.toContain("decoded:");
    expect(capturedPrompt).toContain("contractspecv0Entries:");
    expect(capturedPrompt).not.toContain("contractmetav0[");
  });

  it("summarizes bulky evidence collections in compact prompt profiles", async () => {
    const env = createTestEnv();
    let capturedPrompt = "";
    env.AI = {
      run: vi.fn(async (_model, params: any) => {
        capturedPrompt = params.messages[1].content;
        return JSON.stringify({
          summary: "summary",
          errorCategory: "auth:invalid_action",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["tx_bad_auth"],
          debugSteps: ["step"],
          confidence: "high",
        });
      }),
    } as unknown as Ai;

    const huge = "x".repeat(70000);
    await analyzeFailedTransaction(
      env,
      createFailedTx({
        envelopeJson: { envelope: huge },
        processingJson: { processing: huge },
        decoded: {
          ...createFailedTx().decoded,
          decodedEnvelope: { decodedEnvelope: huge },
          decodedProcessing: { decodedProcessing: huge },
          diagnosticEvents: Array.from({ length: 250 }, (_, index) => ({
            type: "diagnostic",
            index,
            message: huge,
          })),
          contractEvents: Array.from({ length: 100 }, (_, index) => ({
            type: "contract",
            index,
            payload: huge,
          })),
        },
      }),
      createContractMetadata(),
    );

    expect(capturedPrompt).toContain("diagnosticEvents:");
    expect(capturedPrompt).toContain("count:");
    expect(capturedPrompt).toContain("preview[");
    expect(capturedPrompt.length).toBeLessThan(25000);
  });

  it("retries Kimi without falling back to another model", async () => {
    const env = createTestEnv();
    env.AI_ANALYSIS_MAX_DURATION_MS = "4000";
    const calls: string[] = [];
    env.AI = {
      run: vi.fn(async (model: string) => {
        calls.push(model);
        if (calls.length === 1) {
          throw new Error("504 Gateway Timeout");
        }
        return JSON.stringify({
          summary: "summary",
          errorCategory: "builtin:ok",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["TrustlineMissingError"],
          debugSteps: ["step"],
          confidence: "medium",
        });
      }),
    } as unknown as Ai;

    const result = await analyzeFailedTransaction(
      env,
      createFailedTx(),
      createContractMetadata(),
    );

    expect(result.errorCategory).toBe("builtin:ok");
    expect(calls).toHaveLength(2);
    expect(calls.every((model) => model === env.AI_ANALYSIS_MODEL)).toBe(true);
  });

  it("retries Kimi on transient network connection loss", async () => {
    const env = createTestEnv();
    env.AI_ANALYSIS_MAX_DURATION_MS = "4000";
    const calls: string[] = [];
    env.AI = {
      run: vi.fn(async (model: string) => {
        calls.push(model);
        if (calls.length === 1) {
          throw new Error("Network connection lost.");
        }
        return JSON.stringify({
          summary: "summary",
          errorCategory: "builtin:ok",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["TrustlineMissingError"],
          debugSteps: ["step"],
          confidence: "medium",
        });
      }),
    } as unknown as Ai;

    const result = await analyzeFailedTransaction(
      env,
      createFailedTx(),
      createContractMetadata(),
    );

    expect(result.errorCategory).toBe("builtin:ok");
    expect(calls).toHaveLength(2);
    expect(calls.every((model) => model === env.AI_ANALYSIS_MODEL)).toBe(true);
  });

  it("emits progress callbacks for profile start, retries, and heartbeats", async () => {
    const env = createTestEnv();
    env.AI_ANALYSIS_TIMEOUT_MS = "1000";
    env.AI_ANALYSIS_MAX_DURATION_MS = "4000";
    const progress: Array<{ phase: string; attempt: number; profileName: string }> = [];
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const intervalCallbacks: Array<() => void> = [];

    vi.stubGlobal("setInterval", ((callback: TimerHandler) => {
      if (typeof callback === "function") {
        intervalCallbacks.push(callback as () => void);
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    vi.stubGlobal("clearInterval", ((_: unknown) => undefined) as typeof clearInterval);

    let calls = 0;
    env.AI = {
      run: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          intervalCallbacks.at(-1)?.();
          throw new Error("504 Gateway Timeout");
        }
        return JSON.stringify({
          summary: "summary",
          errorCategory: "builtin:ok",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["TrustlineMissingError"],
          debugSteps: ["step"],
          confidence: "medium",
        });
      }),
    } as unknown as Ai;

    try {
      const result = await analyzeFailedTransaction(
        env,
        createFailedTx(),
        createContractMetadata(),
        {
          onProgress: (update) => {
            progress.push({
              phase: update.phase,
              attempt: update.attempt,
              profileName: update.profileName,
            });
          },
        },
      );

      expect(result.errorCategory).toBe("builtin:ok");
      expect(progress.some((entry) => entry.phase === "profile_start")).toBe(true);
      expect(progress.some((entry) => entry.phase === "attempt_start")).toBe(true);
      expect(progress.some((entry) => entry.phase === "attempt_heartbeat")).toBe(true);
      expect(progress.some((entry) => entry.phase === "retry_scheduled")).toBe(true);
      expect(progress.some((entry) => entry.phase === "success")).toBe(true);
    } finally {
      vi.stubGlobal("setInterval", realSetInterval);
      vi.stubGlobal("clearInterval", realClearInterval);
    }
  });

  it("rebuilds the prompt with a tighter profile when the model hits a context window limit", async () => {
    const env = createTestEnv();
    const prompts: string[] = [];
    env.AI = {
      run: vi.fn(async (_model: string, params: any) => {
        const prompt = params.messages[1].content as string;
        prompts.push(prompt);
        if (prompt.includes("raw:")) {
          throw new Error(
            "5021: The estimated number of input and maximum output tokens (31271) exceeded this model context window limit (24000).",
          );
        }
        return JSON.stringify({
          summary: "summary",
          errorCategory: "auth:invalid_action",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["Error(Auth, InvalidAction)"],
          debugSteps: ["step"],
          confidence: "high",
        });
      }),
    } as unknown as Ai;

    const result = await analyzeFailedTransaction(
      env,
      createFailedTx(),
      createContractMetadata(),
    );

    expect(result.errorCategory).toBe("auth:invalid_action");
    expect(prompts.length).toBeGreaterThan(2);
    expect(prompts[0]).toContain("raw:");
    expect(prompts.at(-1)).not.toContain("raw:");
    expect(prompts.at(-1)).toContain("builtinInsights[");
  });

  it("compacts to the next profile after repeated transport failures", async () => {
    const env = createTestEnv();
    const prompts: string[] = [];
    const huge = "x".repeat(70000);
    env.AI_ANALYSIS_MAX_DURATION_MS = "20000";
    env.AI = {
      run: vi.fn(async (_model: string, params: any) => {
        const prompt = params.messages[1].content as string;
        prompts.push(prompt);
        if (prompts.length <= 3) {
          throw new Error("504 Gateway Timeout");
        }
        return JSON.stringify({
          summary: "summary",
          errorCategory: "auth:invalid_action",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["Error(Auth, InvalidAction)"],
          debugSteps: ["step"],
          confidence: "high",
        });
      }),
    } as unknown as Ai;

    const result = await analyzeFailedTransaction(
      env,
      createFailedTx({
        envelopeJson: { envelope: huge },
        processingJson: { processing: huge },
        decoded: {
          ...createFailedTx().decoded,
          decodedEnvelope: { decodedEnvelope: huge },
          decodedProcessing: { decodedProcessing: huge },
          diagnosticEvents: Array.from({ length: 250 }, (_, index) => ({
            type: "diagnostic",
            index,
            message: huge,
          })),
          contractEvents: Array.from({ length: 100 }, (_, index) => ({
            type: "contract",
            index,
            payload: huge,
          })),
        },
      }),
      createContractMetadata(),
    );

    expect(result.errorCategory).toBe("auth:invalid_action");
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toBe(prompts[1]);
    expect(prompts[1]).toBe(prompts[2]);
    expect(prompts[3].length).toBeLessThan(prompts[2].length);
  });

  it("rebuilds the prompt with a tighter profile when Kimi returns an empty length-truncated response", async () => {
    const env = createTestEnv();
    const prompts: string[] = [];
    const huge = "x".repeat(70000);
    env.AI = {
      run: vi.fn(async (_model: string, params: any) => {
        const prompt = params.messages[1].content as string;
        prompts.push(prompt);
        if (prompts.length === 1) {
          return {
            choices: [
              {
                message: { content: "" },
                finish_reason: "length",
              },
            ],
          };
        }
        return JSON.stringify({
          summary: "summary",
          errorCategory: "auth:invalid_action",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["Error(Auth, InvalidAction)"],
          debugSteps: ["step"],
          confidence: "high",
        });
      }),
    } as unknown as Ai;

    const result = await analyzeFailedTransaction(
      env,
      createFailedTx({
        envelopeJson: { envelope: huge },
        processingJson: { processing: huge },
        decoded: {
          ...createFailedTx().decoded,
          decodedEnvelope: { decodedEnvelope: huge },
          decodedProcessing: { decodedProcessing: huge },
          diagnosticEvents: Array.from({ length: 250 }, (_, index) => ({
            type: "diagnostic",
            index,
            message: huge,
          })),
          contractEvents: Array.from({ length: 100 }, (_, index) => ({
            type: "contract",
            index,
            payload: huge,
          })),
        },
      }),
      createContractMetadata(),
    );

    expect(result.errorCategory).toBe("auth:invalid_action");
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[1].length).toBeLessThan(prompts[0].length);
  });

  it("parses JSON when Kimi returns a partially fenced response", async () => {
    const env = createTestEnv();
    env.AI = {
      run: vi.fn(async () => `\`\`\`json
{
  "summary": "summary",
  "errorCategory": "auth:invalid_action",
  "likelyCause": "cause",
  "suggestedFix": "fix",
  "detailedAnalysis": "details",
  "evidence": ["evidence"],
  "relatedCodes": ["Error(Auth, InvalidAction)"],
  "debugSteps": ["step"],
  "confidence": "high"
}`),
    } as unknown as Ai;

    const result = await analyzeFailedTransaction(
      env,
      createFailedTx(),
      createContractMetadata(),
    );

    expect(result.errorCategory).toBe("auth:invalid_action");
    expect(result.summary).toBe("summary");
  });

  it("rebuilds the prompt with a tighter profile when Kimi returns malformed truncated JSON", async () => {
    const env = createTestEnv();
    const prompts: string[] = [];
    const huge = "x".repeat(70000);
    env.AI = {
      run: vi.fn(async (_model: string, params: any) => {
        const prompt = params.messages[1].content as string;
        prompts.push(prompt);
        if (prompts.length === 1) {
          return `{"summary":"summary","errorCategory":"auth:invalid_action","likelyCause":"${"x".repeat(200)}`;
        }
        return JSON.stringify({
          summary: "summary",
          errorCategory: "auth:invalid_action",
          likelyCause: "cause",
          suggestedFix: "fix",
          detailedAnalysis: "details",
          evidence: ["evidence"],
          relatedCodes: ["Error(Auth, InvalidAction)"],
          debugSteps: ["step"],
          confidence: "high",
        });
      }),
    } as unknown as Ai;

    const result = await analyzeFailedTransaction(
      env,
      createFailedTx({
        envelopeJson: { envelope: huge },
        processingJson: { processing: huge },
        decoded: {
          ...createFailedTx().decoded,
          decodedEnvelope: { decodedEnvelope: huge },
          decodedProcessing: { decodedProcessing: huge },
          diagnosticEvents: Array.from({ length: 250 }, (_, index) => ({
            type: "diagnostic",
            index,
            message: huge,
          })),
          contractEvents: Array.from({ length: 100 }, (_, index) => ({
            type: "contract",
            index,
            payload: huge,
          })),
        },
      }),
      createContractMetadata(),
    );

    expect(result.errorCategory).toBe("auth:invalid_action");
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[1].length).toBeLessThan(prompts[0].length);
  });

  it("fails explicitly when Kimi exhausts the retry window", async () => {
    const env = createTestEnv();
    env.AI_ANALYSIS_MAX_DURATION_MS = "1500";
    const calls: string[] = [];
    env.AI = {
      run: vi.fn(async (model: string, params: any) => {
        void params;
        calls.push(model);
        throw new Error("504 Gateway Timeout");
      }),
    } as unknown as Ai;

    const result = await analyzeFailedTransaction(
      env,
      createFailedTx(),
      createContractMetadata(),
    );

    expect(result.errorCategory).toBe("analysis:kimi_unavailable");
    expect(result.modelId).toBe(env.AI_ANALYSIS_MODEL);
    expect(result.summary).toContain("Kimi did not return a usable response");
    expect(result.summary).toContain(env.AI_ANALYSIS_MODEL);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((model) => model === env.AI_ANALYSIS_MODEL)).toBe(true);
  }, 10000);
});
