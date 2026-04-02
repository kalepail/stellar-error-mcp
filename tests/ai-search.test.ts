import { describe, expect, it } from "vitest";
import {
  AI_SEARCH_CUSTOM_METADATA,
  buildAiSearchFilters,
  buildSearchDocument,
  SEARCH_DOCS_FOLDER,
  SEARCH_DOCS_INCLUDE_PATTERN,
} from "../src/ai-search.js";

const entry = {
  fingerprint: "fp-123",
  contractIds: ["CAAAAA", "CBBBBB"],
  functionName: "swap",
  errorSignatures: [
    { type: "host", code: "Auth.InvalidAction" },
    { type: "contract", code: "Error::PriceTooLow" },
  ],
  resultKind: "tx_failed",
  sorobanOperationTypes: ["invoke_host_function"],
  summary: "Swap failed because the quoted output was below the minimum.",
  errorCategory: "contract:Error::PriceTooLow",
  likelyCause: "Slippage moved outside the caller's limit.",
  suggestedFix: "Refresh the quote and widen the minimum only if acceptable.",
  detailedAnalysis:
    "The failure happened inside the swap path before final settlement.",
  evidence: ["The contract emitted PriceTooLow."],
  relatedCodes: ["Error::PriceTooLow"],
  debugSteps: ["Replay with fresh pool state."],
  confidence: "medium" as const,
  modelId: "model",
  seenCount: 3,
  txHashes: ["tx-1", "tx-2", "tx-3"],
  firstSeen: "2026-04-01T00:00:00.000Z",
  lastSeen: "2026-04-02T00:00:00.000Z",
  exampleTxHash: "tx-3",
  exampleReadout: {
    resultKind: "tx_failed",
    feeBump: false,
    invokeCallCount: 1,
    contractCount: 2,
    hasSorobanMeta: true,
    hasEvents: true,
    hasDiagnosticEvents: true,
  },
  contractContext: "swap(token_in, token_out, min_out)",
};

describe("ai search helpers", () => {
  it("builds a dedicated markdown document and metadata schema", () => {
    const document = buildSearchDocument(entry);

    expect(document.key).toBe("search-docs/fp-123.md");
    expect(document.metadata).toEqual({
      fingerprint: "fp-123",
      error_category: "contract:Error::PriceTooLow",
      function_name: "swap",
      primary_contract: "CAAAAA",
      operation_type: "invoke_host_function",
    });
    expect(document.content).toContain("## Detailed Analysis");
    expect(document.content).toContain("## Error Signatures");
    expect(document.content).toContain("host:Auth.InvalidAction");
  });

  it("always scopes filters to the search-docs folder", () => {
    expect(buildAiSearchFilters({})).toEqual({
      type: "eq",
      key: "folder",
      value: SEARCH_DOCS_FOLDER,
    });

    expect(
      buildAiSearchFilters({
        contractId: "CAAAAA",
        functionName: "swap",
      }),
    ).toEqual({
      type: "and",
      filters: [
        { type: "eq", key: "folder", value: SEARCH_DOCS_FOLDER },
        { type: "eq", key: "primary_contract", value: "CAAAAA" },
        { type: "eq", key: "function_name", value: "swap" },
      ],
    });
  });

  it("exports the expected v1 search config constants", () => {
    expect(SEARCH_DOCS_INCLUDE_PATTERN).toBe("/search-docs/**");
    expect(AI_SEARCH_CUSTOM_METADATA).toEqual([
      { field_name: "fingerprint", data_type: "text" },
      { field_name: "error_category", data_type: "text" },
      { field_name: "function_name", data_type: "text" },
      { field_name: "primary_contract", data_type: "text" },
      { field_name: "operation_type", data_type: "text" },
    ]);
  });
});
