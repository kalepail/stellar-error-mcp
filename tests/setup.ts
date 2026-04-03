import { vi } from "vitest";

vi.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint<Env = unknown> {
    protected ctx: ExecutionContext;
    protected env: Env;

    constructor(ctx: ExecutionContext, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  }

  return { WorkflowEntrypoint };
});

vi.mock("cloudflare:workflows", () => {
  class NonRetryableError extends Error {
    constructor(message: string, name = "NonRetryableError") {
      super(message);
      this.name = name;
    }
  }

  return { NonRetryableError };
});
