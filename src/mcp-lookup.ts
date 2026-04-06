import type { Env, ErrorEntry } from "./types.js";
import { buildSearchDocument } from "./ai-search.js";
import { findErrorEntryByTxHash, getErrorEntry } from "./storage.js";

const EXACT_HEX_64 = /^[a-f0-9]{64}$/i;

export async function findExactErrorEntryForQuery(
  env: Env,
  query: string,
): Promise<ErrorEntry | null> {
  const trimmed = query.trim();
  if (!EXACT_HEX_64.test(trimmed)) {
    return null;
  }

  const byTxHash = await findErrorEntryByTxHash(env, trimmed);
  if (byTxHash) {
    return byTxHash;
  }

  return await getErrorEntry(env, trimmed);
}

export function buildStoredDiagnosisText(entry: ErrorEntry): string {
  const evidence = entry.evidence.map((item) => `- ${item}`).join("\n");
  const debugSteps = entry.debugSteps.map((item) => `- ${item}`).join("\n");
  const relatedCodes = entry.relatedCodes.map((item) => `- ${item}`).join("\n");

  return [
    "## Diagnosis",
    "",
    entry.summary,
    "",
    `Category: ${entry.errorCategory}`,
    `Likely cause: ${entry.likelyCause}`,
    `Suggested fix: ${entry.suggestedFix}`,
    `Confidence: ${entry.confidence}`,
    "",
    "## Detailed Analysis",
    "",
    entry.detailedAnalysis,
    "",
    "## Evidence",
    evidence || "- None recorded",
    "",
    "## Debug Steps",
    debugSteps || "- None recorded",
    "",
    "## Related Codes",
    relatedCodes || "- None recorded",
    "",
    "## Sources",
    `- search-docs/${entry.fingerprint}.md (exact stored match)`,
  ].join("\n");
}

export function buildStoredSearchResult(entry: ErrorEntry): Array<Record<string, unknown>> {
  const document = buildSearchDocument(entry);
  return [
    {
      filename: document.key,
      score: 1,
      attributes: document.metadata,
      text: document.content,
    },
  ];
}
