import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";

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

  it("extracts invoke metadata from SDK-style envelope JSON", async () => {
    const {
      buildDecodedTransactionContext,
      collectContractIdsFromValue,
      extractOperationTypes,
      extractSorobanOperationTypes,
    } = await import("../src/transaction.js");

    const primaryContractId =
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const authContractId =
      "CBQVIRSH6EMJVR4SBEMUOZ3ZFFYI6FTQW7DMNESA2BB2XOVYG24FX47T";
    const primaryContractBytes = [...StrKey.decodeContract(primaryContractId)];
    const authContractBytes = [...StrKey.decodeContract(authContractId)];

    const envelope = {
      _arm: "v1",
      _value: {
        _attributes: {
          tx: {
            _attributes: {
              operations: [
                {
                  _attributes: {
                    body: {
                      _switch: { name: "invokeHostFunction", value: 24 },
                      _arm: "invokeHostFunctionOp",
                      _value: {
                        _attributes: {
                          hostFunction: {
                            _arm: "invokeContract",
                            _value: {
                              _attributes: {
                                contractAddress: {
                                  _switch: { name: "scAddressTypeContract", value: 1 },
                                  _arm: "contractId",
                                  _value: { type: "Buffer", data: primaryContractBytes },
                                },
                                functionName: {
                                  type: "Buffer",
                                  data: [...Buffer.from("transfer", "utf8")],
                                },
                                args: [],
                              },
                            },
                          },
                          auth: [
                            {
                              credentials: {
                                address: {
                                  _attributes: {
                                    address: {
                                      _switch: { name: "scAddressTypeContract", value: 1 },
                                      _arm: "contractId",
                                      _value: { type: "Buffer", data: authContractBytes },
                                    },
                                  },
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    };
    const processing = {
      result: { result: { tx_failed: [] } },
      tx_apply_processing: {
        v4: {
          operations: [],
          diagnostic_events: [],
          events: [],
        },
      },
    };

    const decoded = buildDecodedTransactionContext(envelope, processing);

    expect(decoded.topLevelFunction).toBe("transfer");
    expect(decoded.invokeCalls).toMatchObject([
      {
        contractId: primaryContractId,
        functionName: "transfer",
      },
    ]);
    expect(decoded.authEntries).toHaveLength(1);
    expect(decoded.touchedContractIds).toEqual(
      expect.arrayContaining([primaryContractId, authContractId]),
    );
    expect(collectContractIdsFromValue(envelope)).toEqual(
      expect.arrayContaining([primaryContractId, authContractId]),
    );
    expect(extractOperationTypes(envelope)).toEqual(["invoke_host_function"]);
    expect(extractSorobanOperationTypes(envelope)).toEqual([
      "invoke_host_function",
    ]);
  });

  it("extracts error signatures from SDK-style diagnostic event JSON", async () => {
    const { extractErrorSignatures } = await import("../src/transaction.js");

    const signatures = extractErrorSignatures([
      {
        _attributes: {
          event: {
            _attributes: {
              body: {
                _value: {
                  _attributes: {
                    topics: [
                      { _value: { type: "Buffer", data: [...Buffer.from("error")] } },
                      {
                        _switch: { name: "scvError", value: 2 },
                        _arm: "error",
                        _value: {
                          _switch: { name: "sceAuth", value: 9 },
                          _arm: "code",
                          _value: { name: "scecInvalidAction", value: 6 },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    ]);

    expect(signatures).toEqual([{ type: "auth", code: "invalid_action" }]);
  });

  it("extracts plain Error(...) literals from diagnostic strings", async () => {
    const { extractErrorSignatures } = await import("../src/transaction.js");

    const signatures = extractErrorSignatures([
      {
        message: "Error(Contract, #13)",
        details: ["Error(Auth, InvalidAction)", "ignored"],
      },
    ]);

    expect(signatures).toEqual(
      expect.arrayContaining([
        { type: "contract", code: "13" },
        { type: "auth", code: "invalid_action" },
      ]),
    );
  });
});
