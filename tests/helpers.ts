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

  getJson(key: string): unknown {
    const stored = this.objects.get(key);
    return stored ? JSON.parse(stored.body) : null;
  }

  getPutOptions(key: string): R2PutOptions | undefined {
    return this.objects.get(key)?.options;
  }
}

export function createTestEnv(
  bucket = new MemoryR2Bucket(),
): Env & { ERRORS_BUCKET: MemoryR2Bucket } {
  return {
    ERRORS_BUCKET: bucket,
    CURSOR_KV: {
      get: async () => null,
      put: async () => undefined,
    } as KVNamespace,
    VECTORIZE: {
      query: async () => ({ count: 0, matches: [] }),
      upsert: async () => undefined,
    } as unknown as VectorizeIndex,
    AI: {
      run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
    } as unknown as Ai,
    STELLAR_ARCHIVE_RPC_TOKEN: "token",
    STELLAR_ARCHIVE_RPC_ENDPOINT: "https://rpc.example.com",
    AI_SEARCH_INSTANCE: "search",
    AI_SEARCH_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    AI_ANALYSIS_MODEL: "@cf/moonshotai/kimi-k2.5",
  };
}
