export interface Env {
  ERRORS_BUCKET: R2Bucket;
  CURSOR_KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  DIRECT_ERROR_WORKFLOW: Workflow<DirectErrorWorkflowParams>;
  LEDGER_RANGE_WORKFLOW: Workflow<LedgerRangeWorkflowParams>;
  MANAGEMENT_TOKEN?: string;
  MANAGEMENT_TOKEN_SECONDARY?: string;
  STELLAR_ARCHIVE_RPC_TOKEN: string;
  STELLAR_ARCHIVE_RPC_ENDPOINT: string;
  STELLAR_RPC_ENDPOINT?: string;
  STELLAR_RPC_AUTH_MODE?: "header" | "path";
  AI_SEARCH_INSTANCE: string;
  AI_SEARCH_MODEL: string;
  AI_ANALYSIS_MODEL: string;
}

export interface ErrorSignature {
  type: string; // e.g. "auth", "contract", "wasm"
  code: string; // e.g. "invalid_input", "8", "unreachable"
}

export type ObservationKind =
  | "ledger_scan"
  | "rpc_send"
  | "rpc_simulate";

export interface TransactionInvokeCall {
  contractId?: unknown;
  functionName?: unknown;
  args?: unknown;
  argCount?: number;
  auth?: unknown;
  authCount?: number;
}

export interface TransactionResourceLimits {
  instructions?: number;
  readBytes?: number;
  writeBytes?: number;
  extendedMetaDataSizeBytes?: number;
}

export interface TransactionOperationContext {
  index: number;
  operationType?: string;
  sourceAccount?: string;
  envelopeOperation: unknown;
  processing: unknown;
  changeCount: number;
  eventCount: number;
  diagnosticEventCount: number;
  touchedContractIds: string[];
  changes: unknown[];
  events: unknown[];
  diagnosticEvents: unknown[];
}

export interface TransactionLedgerChange {
  operationIndex: number;
  changeType?: string;
  ledgerEntryType?: string;
  contractIds: string[];
  change: unknown;
}

export interface DecodedTransactionContext {
  topLevelFunction: string;
  errorSignatures: ErrorSignature[];
  invokeCalls: TransactionInvokeCall[];
  authEntries: unknown[];
  resourceLimits: TransactionResourceLimits | null;
  transactionResult: unknown;
  sorobanMeta: unknown;
  contractEvents: unknown[];
  diagnosticEvents: unknown[];
  envelopeOperations: unknown[];
  processingOperations: TransactionOperationContext[];
  ledgerChanges: TransactionLedgerChange[];
  touchedContractIds: string[];
  decodedEnvelope?: unknown;
  decodedProcessing?: unknown;
}

export interface ContractFunction {
  name: string;
  doc?: string;
  inputs: Array<{ name: string; type: string }>;
  outputs: string[];
}

export interface ContractErrorEnum {
  name: string;
  cases: Array<{ name: string; value: number; doc?: string }>;
}

export interface ContractStruct {
  name: string;
  fields: Array<{ name: string; type: string }>;
}

export interface ContractCustomSections {
  contractspecv0?: unknown[];
  contractmetav0?: unknown[];
  contractenvmetav0?: unknown[];
}

export interface ContractMetadata {
  contractId: string;
  wasmHash: string;
  functions: ContractFunction[];
  errorEnums: ContractErrorEnum[];
  structs: ContractStruct[];
  customSections?: ContractCustomSections;
  fetchedAt: string;
}

export interface FailedTransaction {
  observationKind: ObservationKind;
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
  decoded: DecodedTransactionContext;
  readout: ErrorReadout;
  sourcePayload?: unknown;
}

export interface ErrorReadout {
  observationKind: ObservationKind;
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
  latestLedger?: number;
  latestLedgerCloseTime?: number;
  rpcStatus?: string;
  simulationError?: string;
  sourceReference?: string;
}

// Canonical deduplicated error entry stored in R2
export interface ErrorEntry {
  fingerprint: string;
  observationKinds: ObservationKind[];
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
  detailedAnalysis: string;
  evidence: string[];
  relatedCodes: string[];
  debugSteps: string[];
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
  // Optional contract context included in the searchable Markdown doc
  contractContext?: string;
}

export interface ExampleTransactionRecord {
  fingerprint: string;
  storedAt: string;
  transaction: FailedTransaction;
  contracts: ContractMetadata[];
}

export interface AnalysisResult {
  txHash: string;
  summary: string;
  errorCategory: string;
  likelyCause: string;
  suggestedFix: string;
  detailedAnalysis: string;
  evidence: string[];
  relatedCodes: string[];
  debugSteps: string[];
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

export interface DirectErrorSubmission {
  kind: Exclude<ObservationKind, "ledger_scan">;
  transactionXdr: string;
  response: Record<string, unknown>;
  submittedAt?: string;
  sourceLabel?: string;
}

export type AsyncJobKind =
  | "direct_error"
  | "ledger_batch"
  | "recurring_scan";

export type AsyncJobStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

export type AsyncJobPhase =
  | "accepted"
  | "preflight"
  | "scanning"
  | "normalizing"
  | "dedupe"
  | "analyzing"
  | "storing"
  | "completed"
  | "failed";

export interface AsyncJobProgress {
  completed: number;
  total?: number;
  unit: string;
  message?: string;
}

export interface PublicFailedTransaction
  extends Omit<FailedTransaction, "sourcePayload"> {
  processingJson: unknown;
}

export interface PublicExampleTransactionRecord
  extends Omit<ExampleTransactionRecord, "transaction"> {
  transaction: PublicFailedTransaction;
}

export interface DirectErrorJobResult {
  duplicate: boolean;
  fingerprint: string;
  entry: ErrorEntry;
  example: PublicExampleTransactionRecord | null;
}

export interface LedgerRangeJobResult {
  batchStart: number;
  batchEnd: number;
  ledgersScanned: number;
  pagesScanned: number;
  failedTransactions: number;
  newErrors: number;
  duplicates: number;
  lastLedgerProcessed?: number;
  artifactKey?: string;
}

export type AsyncJobResult =
  | DirectErrorJobResult
  | LedgerRangeJobResult;

export interface AsyncJob {
  jobId: string;
  kind: AsyncJobKind;
  status: AsyncJobStatus;
  phase: AsyncJobPhase;
  createdAt: string;
  updatedAt: string;
  progress: AsyncJobProgress;
  sourceReference?: string;
  workflowStatus?: string;
  error?: string;
  result?: AsyncJobResult;
}

export interface DirectErrorWorkflowInput {
  jobId: string;
  sourceReference: string;
  stagedTransactionKey: string;
  txHash: string;
}

export type LedgerRangeJobMode = "batch" | "recurring";

export interface LedgerRangeWorkflowInput {
  jobId: string;
  kind: Extract<AsyncJobKind, "ledger_batch" | "recurring_scan">;
  mode: LedgerRangeJobMode;
  startLedger?: number;
  endLedger?: number;
  hours?: number;
  updateCursor: boolean;
  initiatedBy: string;
}

export type AsyncJobInput =
  | DirectErrorWorkflowInput
  | LedgerRangeWorkflowInput;

export interface DirectErrorWorkflowParams {
  jobId: string;
}

export interface LedgerRangeWorkflowParams {
  jobId: string;
}

export interface StagedFailedTransactionRef {
  key: string;
  txHash: string;
}

export interface LedgerChunkSummary {
  startLedger: number;
  endLedger: number;
  ledgersScanned: number;
  pagesScanned: number;
  failedTransactions: number;
  refs: StagedFailedTransactionRef[];
  lastLedgerProcessed: number;
}

export interface LedgerChunkIngestSummary {
  newErrors: number;
  duplicates: number;
}

export interface ActiveRecurringScanRecord {
  jobId: string;
  updatedAt: string;
}
