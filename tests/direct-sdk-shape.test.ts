import { describe, expect, it, vi } from "vitest";

const PRIMARY_CONTRACT_ID =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const AUTH_CONTRACT_ID =
  "CBQVIRSH6EMJVR4SBEMUOZ3ZFFYI6FTQW7DMNESA2BB2XOVYG24FX47T";

vi.mock("../src/xdr.js", () => ({
  deepDecodeXdr: (value: unknown) => value,
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  const primaryContractBytes = [...actual.StrKey.decodeContract(PRIMARY_CONTRACT_ID)];
  const authContractBytes = [...actual.StrKey.decodeContract(AUTH_CONTRACT_ID)];

  const envelope = {
    _switch: { name: "envelopeTypeTx", value: 2 },
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
                          _switch: {
                            name: "hostFunctionTypeInvokeContract",
                            value: 0,
                          },
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
                                    _switch: {
                                      name: "scAddressTypeContract",
                                      value: 1,
                                    },
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

  const authErrorEvent = {
    _attributes: {
      inSuccessfulContractCall: false,
      event: {
        _attributes: {
          contractId: { type: "Buffer", data: primaryContractBytes },
          body: {
            _value: {
              _attributes: {
                topics: [
                  {
                    _switch: { name: "scvSymbol", value: 15 },
                    _arm: "sym",
                    _value: { type: "Buffer", data: [...Buffer.from("error", "utf8")] },
                  },
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
  };

  const wasmErrorEvent = {
    _attributes: {
      inSuccessfulContractCall: false,
      event: {
        _attributes: {
          contractId: { type: "Buffer", data: authContractBytes },
          body: {
            _value: {
              _attributes: {
                topics: [
                  {
                    _switch: { name: "scvSymbol", value: 15 },
                    _arm: "sym",
                    _value: { type: "Buffer", data: [...Buffer.from("error", "utf8")] },
                  },
                  {
                    _switch: { name: "scvError", value: 2 },
                    _arm: "error",
                    _value: {
                      _switch: { name: "sceWasmVm", value: 1 },
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
  };

  return {
    ...actual,
    xdr: {
      ...actual.xdr,
      TransactionEnvelope: {
        ...actual.xdr.TransactionEnvelope,
        fromXDR: vi.fn(() => envelope),
      },
      DiagnosticEvent: {
        ...actual.xdr.DiagnosticEvent,
        fromXDR: vi.fn((value: string) =>
          value === "EVENT_AUTH" ? authErrorEvent : wasmErrorEvent
        ),
      },
    },
  };
});

describe("direct error normalization with SDK-style XDR JSON", () => {
  it("normalizes simulation payloads into the same core metadata", async () => {
    const { buildFailedTransactionFromDirectError } = await import("../src/direct.js");

    const tx = await buildFailedTransactionFromDirectError({
      kind: "rpc_simulate",
      transactionXdr: "AAAA",
      response: {
        latestLedger: 1901378,
        error:
          "HostError: Error(Auth, InvalidAction)\n\nEvent log (newest first):\n  ...",
        events: ["EVENT_AUTH", "EVENT_WASM"],
      },
    });

    expect(tx.resultKind).toBe("simulate:hosterror_error_auth_invalidaction");
    expect(tx.decoded.topLevelFunction).toBe("transfer");
    expect(tx.operationTypes).toEqual(["invoke_host_function"]);
    expect(tx.sorobanOperationTypes).toEqual(["invoke_host_function"]);
    expect(tx.primaryContractIds).toEqual([PRIMARY_CONTRACT_ID]);
    expect(tx.contractIds).toEqual(
      expect.arrayContaining([PRIMARY_CONTRACT_ID, AUTH_CONTRACT_ID]),
    );
    expect(tx.decoded.errorSignatures).toEqual(
      expect.arrayContaining([
        { type: "auth", code: "invalid_action" },
        { type: "wasm_vm", code: "invalid_action" },
      ]),
    );
  });
});
