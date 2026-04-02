import type { ErrorEntry } from "./types.js";

export const SEARCH_DOCS_PREFIX = "search-docs/";
export const SEARCH_DOCS_FOLDER = "search-docs/";
export const SEARCH_DOCS_INCLUDE_PATTERN = "search-docs/**";

export const AI_SEARCH_CUSTOM_METADATA = [
  { field_name: "fingerprint", data_type: "text" },
  { field_name: "error_category", data_type: "text" },
  { field_name: "function_name", data_type: "text" },
  { field_name: "primary_contract", data_type: "text" },
  { field_name: "operation_type", data_type: "text" },
] as const;

export interface SearchDocumentMetadata {
  fingerprint: string;
  error_category: string;
  function_name: string;
  primary_contract: string;
  operation_type: string;
}

export interface SearchDocumentRecord {
  key: string;
  content: string;
  metadata: SearchDocumentMetadata;
}

export interface SearchFiltersInput {
  fingerprint?: string;
  contractId?: string;
  functionName?: string;
  operationType?: string;
  errorCategory?: string;
}

function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function listSection(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [`## ${title}`, ...items.map((item) => `- ${item}`), ""];
}

function paragraphSection(title: string, value?: string): string[] {
  const cleaned = value ? value.trim() : "";
  if (!cleaned) return [];
  return [`## ${title}`, cleaned, ""];
}

export function buildSearchDocument(entry: ErrorEntry): SearchDocumentRecord {
  const primaryContract = entry.contractIds[0] ?? "";
  const operationType = entry.sorobanOperationTypes[0] ?? "";
  const signatureLines = entry.errorSignatures.map((signature) =>
    `${signature.type}:${signature.code}`
  );
  const metadata: SearchDocumentMetadata = {
    fingerprint: entry.fingerprint,
    error_category: entry.errorCategory,
    function_name: entry.functionName,
    primary_contract: primaryContract,
    operation_type: operationType,
  };

  const lines = [
    `# ${cleanLine(entry.summary)}`,
    "",
    `Fingerprint: ${entry.fingerprint}`,
    `Error category: ${entry.errorCategory}`,
    `Function: ${entry.functionName}`,
    `Primary contract: ${primaryContract || "unknown"}`,
    `Operation type: ${operationType || "unknown"}`,
    `Result kind: ${entry.resultKind}`,
    `Confidence: ${entry.confidence}`,
    `Occurrences: ${entry.seenCount}`,
    `First seen: ${entry.firstSeen}`,
    `Last seen: ${entry.lastSeen}`,
    `Example transaction: ${entry.exampleTxHash}`,
    "",
    ...paragraphSection("Likely Cause", entry.likelyCause),
    ...paragraphSection("Suggested Fix", entry.suggestedFix),
    ...paragraphSection("Detailed Analysis", entry.detailedAnalysis),
    ...listSection("Evidence", entry.evidence),
    ...listSection("Related Codes", entry.relatedCodes),
    ...listSection("Error Signatures", signatureLines),
    ...listSection("Debug Steps", entry.debugSteps),
    ...listSection("Contracts", entry.contractIds),
    ...listSection("Recent Transaction Hashes", entry.txHashes),
    ...paragraphSection("Contract Context", entry.contractContext),
  ].filter((line, index, all) => {
    if (line !== "") return true;
    return index > 0 && all[index - 1] !== "";
  });

  return {
    key: `${SEARCH_DOCS_PREFIX}${entry.fingerprint}.md`,
    content: `${lines.join("\n").trim()}\n`,
    metadata,
  };
}

function eqFilter(key: string, value: string): Record<string, unknown> | null {
  if (!value.trim()) return null;
  return { type: "eq", key, value };
}

export function buildAiSearchFilters(
  input: SearchFiltersInput,
): Record<string, unknown> {
  const filters = [
    eqFilter("folder", SEARCH_DOCS_FOLDER),
    eqFilter("fingerprint", input.fingerprint ?? ""),
    eqFilter("primary_contract", input.contractId ?? ""),
    eqFilter("function_name", input.functionName ?? ""),
    eqFilter("operation_type", input.operationType ?? ""),
    eqFilter("error_category", input.errorCategory ?? ""),
  ].filter((filter): filter is Record<string, unknown> => filter !== null);

  if (filters.length === 1) {
    return filters[0];
  }

  return {
    type: "and",
    filters,
  };
}
