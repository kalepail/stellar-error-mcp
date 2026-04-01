export interface Env {
  ERRORS_BUCKET: R2Bucket;
  CURSOR_KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  LOADER: any; // WorkerLoader — Dynamic Workers binding
  STELLAR_ARCHIVE_RPC_TOKEN: string;
  STELLAR_ARCHIVE_RPC_ENDPOINT: string;
  AI_SEARCH_INSTANCE: string;
  AI_MODEL: string;
}

export interface FailedTransaction {
  txHash: string;
  ledgerSequence: number;
  ledgerCloseTime: string;
  resultKind: string;
  soroban: true;
  /** Primary contracts from the invoke_host_function envelope — used for fingerprinting */
  primaryContractIds: string[];
  /** All contracts discovered from envelope + diag + auth + meta — used for context/lookup */
  contractIds: string[];
  operationTypes: string[];
  sorobanOperationTypes: string[];
  diagnosticEvents: unknown[];
  envelopeJson: unknown;
  processingJson: unknown;
  readout: ErrorReadout;
}

export interface ErrorReadout {
  resultKind: string;
  feeBump: boolean;
  invokeCallCount: number;
  contractCount: number;
  sourceAccount?: string;
  feeSourceAccount?: string;
  hasSorobanMeta: boolean;
  hasEvents: boolean;
  hasDiagnosticEvents: boolean;
  eventCount?: number;
  diagnosticEventCount?: number;
  returnValue?: unknown;
  nonRefundableResourceFeeCharged?: number;
  refundableResourceFeeCharged?: number;
  rentFeeCharged?: number;
}

export interface ErrorSignature {
  type: string; // e.g. "auth", "contract", "wasm"
  code: string; // e.g. "invalid_input", "8", "unreachable"
}

// Canonical deduplicated error entry stored in R2
export interface ErrorEntry {
  fingerprint: string;
  contractIds: string[];
  functionName: string;
  errorSignatures: ErrorSignature[];
  resultKind: string;
  sorobanOperationTypes: string[];
  // AI analysis
  summary: string;
  errorCategory: string;
  likelyCause: string;
  suggestedFix: string;
  confidence: "high" | "medium" | "low" | "failed";
  modelId: string;
  // Occurrence tracking
  seenCount: number;
  txHashes: string[];
  firstSeen: string;
  lastSeen: string;
  // Vector dedup linkage
  similarTo?: string; // fingerprint of a semantically similar error
  // Reference data
  exampleTxHash: string;
  exampleReadout: ErrorReadout;
  // Contract context for AI Search indexing
  contractContext?: string;
}

export interface AnalysisResult {
  txHash: string;
  summary: string;
  errorCategory: string;
  likelyCause: string;
  suggestedFix: string;
  confidence: "high" | "medium" | "low" | "failed";
  analyzedAt: string;
  modelId: string;
}

export interface ScanResult {
  transactions: FailedTransaction[];
  lastLedgerProcessed: number;
  pagesScanned: number;
  ledgersScanned: number;
}
