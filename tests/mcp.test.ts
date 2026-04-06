import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers.js";
import {
  buildStoredDiagnosisText,
  buildStoredSearchResult,
  findExactErrorEntryForQuery,
} from "../src/mcp-lookup.js";
import { storeErrorEntry, storeTxHashPointer } from "../src/storage.js";

const entry = {
  fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  observationKinds: ["rpc_send"] as const,
  contractIds: [],
  functionName: "unknown",
  errorSignatures: [{ type: "result", code: "tx_bad_auth" }],
  resultKind: "tx_bad_auth",
  sorobanOperationTypes: [],
  summary: "Transaction failed due to missing signatures.",
  errorCategory: "tx:txBadAuth",
  likelyCause: "The envelope was submitted unsigned.",
  suggestedFix: "Sign the transaction before submission.",
  detailedAnalysis: "The transaction was rejected during RPC submission before execution.",
  evidence: ["Envelope signatures array was empty."],
  relatedCodes: ["txBadAuth", "-6"],
  debugSteps: ["Attach the source account signature and retry."],
  confidence: "high" as const,
  modelId: "@cf/moonshotai/kimi-k2.5",
  seenCount: 1,
  txHashes: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  firstSeen: "2026-04-06T00:00:00.000Z",
  lastSeen: "2026-04-06T00:00:00.000Z",
  exampleTxHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  exampleReadout: {
    observationKind: "rpc_send" as const,
    resultKind: "tx_bad_auth",
    feeBump: false,
    invokeCallCount: 0,
    contractCount: 0,
    hasSorobanMeta: false,
    hasEvents: false,
    hasDiagnosticEvents: false,
  },
};

describe("mcp exact lookup helpers", () => {
  it("resolves an exact fingerprint query from storage", async () => {
    const env = createTestEnv();
    await storeErrorEntry(env, entry);

    await expect(
      findExactErrorEntryForQuery(env, entry.fingerprint),
    ).resolves.toMatchObject({
      fingerprint: entry.fingerprint,
      errorCategory: "tx:txBadAuth",
    });
  });

  it("resolves an exact tx hash query through KV", async () => {
    const env = createTestEnv();
    await storeErrorEntry(env, entry);
    await storeTxHashPointer(env, entry.txHashes[0], entry.fingerprint);

    await expect(
      findExactErrorEntryForQuery(env, entry.txHashes[0]),
    ).resolves.toMatchObject({
      fingerprint: entry.fingerprint,
      txHashes: [entry.txHashes[0]],
    });
  });

  it("formats exact stored diagnoses and raw document matches", () => {
    const diagnosis = buildStoredDiagnosisText(entry);
    const matches = buildStoredSearchResult(entry);

    expect(diagnosis).toContain("Transaction failed due to missing signatures.");
    expect(diagnosis).toContain("search-docs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      filename: "search-docs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md",
      score: 1,
    });
  });
});
