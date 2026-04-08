import type { Env } from "../src/types.js";

type StoredObject = {
  body: string;
  options?: R2PutOptions;
};

export class MemoryR2Bucket {
  readonly objects = new Map<string, StoredObject>();
  readonly getCalls: string[] = [];
  readonly listCalls: Array<{ prefix: string; cursor?: string }> = [];

  async get(key: string): Promise<R2ObjectBody | null> {
    this.getCalls.push(key);
    const stored = this.objects.get(key);
    if (!stored) return null;

    return {
      json: async () => JSON.parse(stored.body),
      text: async () => stored.body,
    } as unknown as R2ObjectBody;
  }

  async put(
    key: string,
    value: string,
    options?: R2PutOptions,
  ): Promise<void> {
    this.objects.set(key, {
      body: value,
      options,
    });
  }

  async list(
    options: R2ListOptions = {},
  ): Promise<R2Objects> {
    const prefix = options.prefix ?? "";
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const slice = keys.slice(start, start + limit);

    this.listCalls.push({ prefix, cursor: options.cursor });

    return {
      objects: slice.map((key) => ({
        key,
        size: this.objects.get(key)?.body.length ?? 0,
        uploaded: new Date("2026-04-02T00:00:00.000Z"),
      })),
      truncated: start + limit < keys.length,
      cursor: String(start + limit),
      delimitedPrefixes: [],
    } as unknown as R2Objects;
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      this.objects.delete(key);
    }
  }

  getJson(key: string): unknown {
    const stored = this.objects.get(key);
    return stored ? JSON.parse(stored.body) : null;
  }

  getPutOptions(key: string): R2PutOptions | undefined {
    return this.objects.get(key)?.options;
  }
}

export class MemoryWorkflowBinding<PARAMS = unknown> {
  readonly created: WorkflowInstanceCreateOptions<PARAMS>[] = [];
  readonly statuses = new Map<string, InstanceStatus>();

  async create(
    options: WorkflowInstanceCreateOptions<PARAMS> = {},
  ): Promise<WorkflowInstance> {
    const id = options.id ?? `wf_${this.created.length + 1}`;
    this.created.push({ ...options, id });
    if (!this.statuses.has(id)) {
      this.statuses.set(id, { status: "queued" });
    }
    return this.get(id);
  }

  async get(id: string): Promise<WorkflowInstance> {
    return {
      id,
      pause: async () => undefined,
      resume: async () => undefined,
      terminate: async () => undefined,
      restart: async () => undefined,
      status: async () => this.statuses.get(id) ?? { status: "unknown" },
      sendEvent: async () => undefined,
    } as WorkflowInstance;
  }

  setStatus(id: string, status: InstanceStatus): void {
    this.statuses.set(id, status);
  }
}

export class MemoryKVNamespace {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export function createTestEnv(
  bucket = new MemoryR2Bucket(),
  workflowBucket = new MemoryR2Bucket(),
): Env & {
  ERRORS_BUCKET: MemoryR2Bucket;
  WORKFLOW_ARTIFACTS_BUCKET: MemoryR2Bucket;
  CURSOR_KV: MemoryKVNamespace;
  DIRECT_ERROR_WORKFLOW: MemoryWorkflowBinding<{ jobId: string }>;
  LEDGER_RANGE_WORKFLOW: MemoryWorkflowBinding<{ jobId: string }>;
} {
  const kv = new MemoryKVNamespace();
  const directWorkflow = new MemoryWorkflowBinding<{ jobId: string }>();
  const ledgerWorkflow = new MemoryWorkflowBinding<{ jobId: string }>();
  return {
    ERRORS_BUCKET: bucket,
    WORKFLOW_ARTIFACTS_BUCKET: workflowBucket,
    CURSOR_KV: kv as unknown as KVNamespace,
    VECTORIZE: {
      query: async () => ({ count: 0, matches: [] }),
      upsert: async () => undefined,
    } as unknown as VectorizeIndex,
    AI: {
      run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
    } as unknown as Ai,
    DIRECT_ERROR_WORKFLOW: directWorkflow as unknown as Workflow<{
      jobId: string;
    }>,
    LEDGER_RANGE_WORKFLOW: ledgerWorkflow as unknown as Workflow<{
      jobId: string;
    }>,
    STELLAR_ARCHIVE_RPC_TOKEN: "token",
    STELLAR_ARCHIVE_RPC_ENDPOINT: "https://archive-rpc.example.com",
    STELLAR_RPC_ENDPOINT: "https://rpc.example.com",
    STELLAR_RPC_AUTH_MODE: "header",
    STELLAR_TESTNET_ARCHIVE_RPC_ENDPOINT: "https://archive-rpc-testnet.example.com",
    STELLAR_TESTNET_RPC_ENDPOINT: "https://rpc-testnet.example.com",
    STELLAR_TESTNET_RPC_TOKEN: "testnet-token",
    STELLAR_TESTNET_RPC_AUTH_MODE: "path",
    AI_SEARCH_INSTANCE: "search",
    AI_SEARCH_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    AI_ANALYSIS_MODEL: "@cf/moonshotai/kimi-k2.5",
    AI_ANALYSIS_TIMEOUT_MS: "5000",
    AI_ANALYSIS_MAX_DURATION_MS: "15000",
    JOB_RETENTION_HOURS: "72",
  };
}
