import { beforeEach, describe, expect, it, vi } from "vitest";

const deepDecodeXdr = vi.fn((value: unknown) => ({
  decoded: value,
}));

vi.mock("../src/xdr.js", () => ({
  deepDecodeXdr,
}));

describe("transaction decoding", () => {
  beforeEach(() => {
    deepDecodeXdr.mockClear();
  });

  it("keeps buildDecodedTransactionContext lightweight", async () => {
    const { buildDecodedTransactionContext } = await import("../src/transaction.js");

    const decoded = buildDecodedTransactionContext(
      {
        tx: {
          tx: {
            operations: [
              {
                body: {
                  invoke_host_function: {
                    host_function: {
                      invoke_contract: {
                        contract_address:
                          "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                        function_name: "transfer",
                        args: [],
                      },
                    },
                    auth: [],
                  },
                },
              },
            ],
          },
        },
      },
      {
        result: { result: { tx_failed: [] } },
        tx_apply_processing: {
          v4: {
            operations: [],
            diagnostic_events: [],
            events: [],
          },
        },
      },
    );

    expect(deepDecodeXdr).not.toHaveBeenCalled();
    expect(decoded.decodedEnvelope).toBeUndefined();
    expect(decoded.decodedProcessing).toBeUndefined();
    expect(decoded.topLevelFunction).toBe("transfer");
  });

  it("adds deep decoded views only when requested", async () => {
    const {
      attachDeepDecodedViews,
      buildDecodedTransactionContext,
    } = await import("../src/transaction.js");

    const envelope = { tx: { tx: { operations: [] } } };
    const processing = {
      result: { result: { tx_failed: [] } },
      tx_apply_processing: { v4: { operations: [], diagnostic_events: [], events: [] } },
    };
    const decoded = buildDecodedTransactionContext(envelope, processing);
    const enriched = attachDeepDecodedViews(decoded, envelope, processing);

    expect(deepDecodeXdr).toHaveBeenCalledTimes(2);
    expect(enriched.decodedEnvelope).toEqual({ decoded: envelope });
    expect(enriched.decodedProcessing).toEqual({ decoded: processing });
  });
});
