import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers.js";

vi.mock("../src/mcp.js", () => ({
  createMcpFetchHandler: async () => () => new Response("mock mcp"),
}));

vi.mock("../src/xdr.js", () => ({
  deepDecodeXdr: (value: unknown) => value,
}));

const submission = {
  kind: "rpc_simulate",
  transactionXdr:
    "AAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABp1o9lAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABzXrHlDVNUPOxhsf77xASbfB/2k8LjWHIuCtc+U6tcSwAAAAHZXhlY3V0ZQAAAAADAAAAEgAAAAHXkotywnA8z+r365/0701QSlWouXn8m0UOoshCtNHOYQAAAA8AAAAIdHJhbnNmZXIAAAAQAAAAAQAAAAMAAAASAAAAAc16x5Q1TVDzsYbH++8QEm3wf9pPC41hyLgrXPlOrXEsAAAAEgAAAAGZH28E7P7H2iQu3i7ds5muWQeGxQ1ET69x36oYUvdmFAAAAAoAAAAAAAAAAAAAAAAF9eEAAAAAAAAAAAAAAAAA",
  response: {
    error:
      "HostError: Error(Contract, #10)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:CDGXVR4UGVGVB45RQ3D7X3YQCJW7A762J4FY2YOIXAVVZ6KOVVYSYBX5, topics:[error, Error(Contract, #10)], data:\"escalating error to VM trap from failed host function call: call\"\n   1: [Diagnostic Event] contract:CDGXVR4UGVGVB45RQ3D7X3YQCJW7A762J4FY2YOIXAVVZ6KOVVYSYBX5, topics:[error, Error(Contract, #10)], data:[\"contract call failed\", transfer, [CDGXVR4UGVGVB45RQ3D7X3YQCJW7A762J4FY2YOIXAVVZ6KOVVYSYBX5, CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU, 100000000]]\n   2: [Failed Diagnostic Event (not emitted)] contract:CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC, topics:[error, Error(Contract, #10)], data:[\"zero balance is not sufficient to spend\", 100000000]\n   3: [Diagnostic Event] contract:CDGXVR4UGVGVB45RQ3D7X3YQCJW7A762J4FY2YOIXAVVZ6KOVVYSYBX5, topics:[fn_call, CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC, transfer], data:[CDGXVR4UGVGVB45RQ3D7X3YQCJW7A762J4FY2YOIXAVVZ6KOVVYSYBX5, CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU, 100000000]\n   4: [Diagnostic Event] topics:[fn_call, CDGXVR4UGVGVB45RQ3D7X3YQCJW7A762J4FY2YOIXAVVZ6KOVVYSYBX5, execute], data:[CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC, transfer, [CDGXVR4UGVGVB45RQ3D7X3YQCJW7A762J4FY2YOIXAVVZ6KOVVYSYBX5, CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU, 100000000]]\n",
    events: [
      "AAAAAAAAAAAAAAAAAAAAAgAAAAAAAAADAAAADwAAAAdmbl9jYWxsAAAAAA0AAAAgzXrHlDVNUPOxhsf77xASbfB/2k8LjWHIuCtc+U6tcSwAAAAPAAAAB2V4ZWN1dGUAAAAAEAAAAAEAAAADAAAAEgAAAAHXkotywnA8z+r365/0701QSlWouXn8m0UOoshCtNHOYQAAAA8AAAAIdHJhbnNmZXIAAAAQAAAAAQAAAAMAAAASAAAAAc16x5Q1TVDzsYbH++8QEm3wf9pPC41hyLgrXPlOrXEsAAAAEgAAAAGZH28E7P7H2iQu3i7ds5muWQeGxQ1ET69x36oYUvdmFAAAAAoAAAAAAAAAAAAAAAAF9eEA",
      "AAAAAAAAAAAAAAABzXrHlDVNUPOxhsf77xASbfB/2k8LjWHIuCtc+U6tcSwAAAACAAAAAAAAAAMAAAAPAAAAB2ZuX2NhbGwAAAAADQAAACDXkotywnA8z+r365/0701QSlWouXn8m0UOoshCtNHOYQAAAA8AAAAIdHJhbnNmZXIAAAAQAAAAAQAAAAMAAAASAAAAAc16x5Q1TVDzsYbH++8QEm3wf9pPC41hyLgrXPlOrXEsAAAAEgAAAAGZH28E7P7H2iQu3i7ds5muWQeGxQ1ET69x36oYUvdmFAAAAAoAAAAAAAAAAAAAAAAF9eEA",
      "AAAAAAAAAAAAAAAB15KLcsJwPM/q9+uf9O9NUEpVqLl5/JtFDqLIQrTRzmEAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAAAAAAKAAAAEAAAAAEAAAACAAAADgAAACd6ZXJvIGJhbGFuY2UgaXMgbm90IHN1ZmZpY2llbnQgdG8gc3BlbmQAAAAACgAAAAAAAAAAAAAAAAX14QA=",
      "AAAAAAAAAAAAAAABzXrHlDVNUPOxhsf77xASbfB/2k8LjWHIuCtc+U6tcSwAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAAAAAAKAAAAEAAAAAEAAAADAAAADgAAABRjb250cmFjdCBjYWxsIGZhaWxlZAAAAA8AAAAIdHJhbnNmZXIAAAAQAAAAAQAAAAMAAAASAAAAAc16x5Q1TVDzsYbH++8QEm3wf9pPC41hyLgrXPlOrXEsAAAAEgAAAAGZH28E7P7H2iQu3i7ds5muWQeGxQ1ET69x36oYUvdmFAAAAAoAAAAAAAAAAAAAAAAF9eEA",
      "AAAAAAAAAAAAAAABzXrHlDVNUPOxhsf77xASbfB/2k8LjWHIuCtc+U6tcSwAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAAAAAAKAAAADgAAAEBlc2NhbGF0aW5nIGVycm9yIHRvIFZNIHRyYXAgZnJvbSBmYWlsZWQgaG9zdCBmdW5jdGlvbiBjYWxsOiBjYWxs",
      "AAAAAAAAAAAAAAABzXrHlDVNUPOxhsf77xASbfB/2k8LjWHIuCtc+U6tcSwAAAACAAAAAAAAAAEAAAAPAAAAA2xvZwAAAAAQAAAAAQAAAAMAAAAOAAAAHlZNIGNhbGwgdHJhcHBlZCB3aXRoIEhvc3RFcnJvcgAAAAAADwAAAAdleGVjdXRlAAAAAAIAAAAAAAAACg==",
    ],
    latestLedger: 1933059,
  },
} as const;

describe("/forward-error rich simulation submission", () => {
  it("stages the enriched transaction shape through the worker", async () => {
    const env = createTestEnv();
    const { default: worker } = await import("../src/index.js");

    const response = await worker.fetch(
      new Request("http://localhost/forward-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submission),
      }),
      env,
      { waitUntil: () => undefined } as ExecutionContext,
    );

    expect(response.status).toBe(202);
    const body = await response.json() as {
      status: string;
      jobId: string;
      sourceReference: string;
    };

    expect(body.status).toBe("accepted");
    expect(body.jobId).toMatch(/^de_/);
    expect(body.sourceReference).toMatch(/^rpcsim-/);

    const staged = [...env.WORKFLOW_ARTIFACTS_BUCKET.objects.entries()].find(([key]) =>
      key.startsWith(`job-staging/${body.jobId}/transactions/`)
    );
    expect(staged).toBeDefined();

    const transaction = JSON.parse(staged![1].body) as {
      resultKind: string;
      primaryContractIds: string[];
      contractIds: string[];
      operationTypes: string[];
      readout: {
        invokeCallCount: number;
        contractCount: number;
        diagnosticEventCount: number;
      };
    };

    expect(transaction.resultKind).toBe("simulate:hosterror_error_contract_10");
    expect(transaction.primaryContractIds).toEqual([
      "CDGXVR4UGVGVB45RQ3D7X3YQCJW7A762J4FY2YOIXAVVZ6KOVVYSYBX5",
    ]);
    expect(transaction.contractIds).toEqual(expect.arrayContaining([
      "CDGXVR4UGVGVB45RQ3D7X3YQCJW7A762J4FY2YOIXAVVZ6KOVVYSYBX5",
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    ]));
    expect(transaction.operationTypes).toEqual(["invoke_host_function"]);
    expect(transaction.readout).toEqual(
      expect.objectContaining({
        invokeCallCount: 1,
        contractCount: 3,
        diagnosticEventCount: 6,
      }),
    );
  });
});
