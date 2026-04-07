import type {
  BuiltinContractDescriptor,
  BuiltinSourceRef,
  BuiltinTxInsight,
  ContractErrorEnum,
  ContractFunction,
  ContractMetadata,
  FailedTransaction,
} from "./types.js";

const BUILTIN_CONTRACT_ERROR_SOURCES: BuiltinSourceRef[] = [
  {
    label: "Builtin Contract Errors",
    url: "https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/builtin_contracts/contract_error.rs",
  },
  {
    label: "Stellar Asset Contract Docs",
    url: "https://developers.stellar.org/docs/tokens/stellar-asset-contract",
  },
];

const STELLAR_ASSET_CONTRACT_SOURCES: BuiltinSourceRef[] = [
  {
    label: "SAC Host Implementation",
    url: "https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/builtin_contracts/stellar_asset_contract/contract.rs",
  },
  {
    label: "Stellar Asset Contract Docs",
    url: "https://developers.stellar.org/docs/tokens/stellar-asset-contract",
  },
  {
    label: "Token Interface Docs",
    url: "https://developers.stellar.org/docs/tokens/token-interface",
  },
];

const ACCOUNT_CONTRACT_SOURCES: BuiltinSourceRef[] = [
  {
    label: "Account Contract Host Implementation",
    url: "https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/builtin_contracts/account_contract.rs",
  },
  {
    label: "Authorization Overview",
    url: "https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization",
  },
];

const INVOKER_CONTRACT_AUTH_SOURCES: BuiltinSourceRef[] = [
  {
    label: "Invoker Contract Auth Host Implementation",
    url: "https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/builtin_contracts/invoker_contract_auth.rs",
  },
  {
    label: "Authorization Overview",
    url: "https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization",
  },
];

const BUILTIN_CONTRACT_ERROR_ENUM: ContractErrorEnum = {
  name: "ContractError",
  cases: [
    {
      name: "OperationNotSupportedError",
      value: 2,
      doc: "Impossible or unsupported built-in action, such as native-asset admin/burn restrictions or issuer-targeted actions.",
    },
    {
      name: "AlreadyInitializedError",
      value: 3,
      doc: "Built-in contract initialization was attempted more than once.",
    },
    {
      name: "UnauthorizedError",
      value: 4,
      doc: "Privileged action was attempted without the required built-in administrator privileges.",
    },
    {
      name: "AuthenticationError",
      value: 5,
      doc: "Authentication payload or signature set failed built-in verification.",
    },
    {
      name: "AccountMissingError",
      value: 6,
      doc: "A classic account required by the built-in contract was missing on-ledger.",
    },
    {
      name: "AccountIsNotClassic",
      value: 7,
      doc: "Built-in flow expected a classic account address but received a contract address or unsupported address kind.",
    },
    {
      name: "NegativeAmountError",
      value: 8,
      doc: "Amount arguments must be non-negative.",
    },
    {
      name: "AllowanceError",
      value: 9,
      doc: "Allowance was insufficient or allowance expiration input was invalid.",
    },
    {
      name: "BalanceError",
      value: 10,
      doc: "Balance was insufficient, invalid, or incompatible with the requested operation.",
    },
    {
      name: "BalanceDeauthorizedError",
      value: 11,
      doc: "Address balance exists but has been deauthorized by the issuer.",
    },
    {
      name: "OverflowError",
      value: 12,
      doc: "The requested built-in state transition would overflow or exceed a bounded counter.",
    },
    {
      name: "TrustlineMissingError",
      value: 13,
      doc: "Classic account trustline required by the asset operation does not exist.",
    },
    {
      name: "InsufficientAccountReserve",
      value: 14,
      doc: "Classic account reserve was too low to create or extend trustline-related state.",
    },
    {
      name: "TooManyAccountSubentries",
      value: 15,
      doc: "Classic account cannot add more subentries, such as a new trustline.",
    },
  ],
};

const STELLAR_ASSET_FUNCTIONS: ContractFunction[] = [
  {
    name: "allowance",
    doc: "Returns the allowance for spender to transfer or burn from from.",
    inputs: [
      { name: "from", type: "Address" },
      { name: "spender", type: "Address" },
    ],
    outputs: ["i128"],
  },
  {
    name: "approve",
    doc: "Sets the spender allowance from from until the specified expiration ledger.",
    inputs: [
      { name: "from", type: "Address" },
      { name: "spender", type: "Address" },
      { name: "amount", type: "i128" },
      { name: "expiration_ledger", type: "u32" },
    ],
    outputs: ["void"],
  },
  {
    name: "balance",
    doc: "Returns the token balance for the supplied address.",
    inputs: [{ name: "id", type: "Address" }],
    outputs: ["i128"],
  },
  {
    name: "authorized",
    doc: "Returns whether the supplied address is authorized to use its balance.",
    inputs: [{ name: "id", type: "Address" }],
    outputs: ["bool"],
  },
  {
    name: "transfer",
    doc: "Transfers amount from from to to. Authorization is required from from.",
    inputs: [
      { name: "from", type: "Address" },
      { name: "to", type: "MuxedAddress" },
      { name: "amount", type: "i128" },
    ],
    outputs: ["void"],
  },
  {
    name: "transfer_from",
    doc: "Transfers amount from from to to using spender allowance. Authorization is required from spender.",
    inputs: [
      { name: "spender", type: "Address" },
      { name: "from", type: "Address" },
      { name: "to", type: "Address" },
      { name: "amount", type: "i128" },
    ],
    outputs: ["void"],
  },
  {
    name: "burn",
    doc: "Burns amount from from. Unsupported for native assets and issuer balances.",
    inputs: [
      { name: "from", type: "Address" },
      { name: "amount", type: "i128" },
    ],
    outputs: ["void"],
  },
  {
    name: "burn_from",
    doc: "Burns amount from from using spender allowance. Unsupported for native assets and issuer balances.",
    inputs: [
      { name: "spender", type: "Address" },
      { name: "from", type: "Address" },
      { name: "amount", type: "i128" },
    ],
    outputs: ["void"],
  },
  {
    name: "clawback",
    doc: "Clawbacks amount from from. Requires administrator auth and a clawback-enabled asset.",
    inputs: [
      { name: "from", type: "Address" },
      { name: "amount", type: "i128" },
    ],
    outputs: ["void"],
  },
  {
    name: "set_authorized",
    doc: "Sets whether an address may use its balance. Requires administrator auth.",
    inputs: [
      { name: "id", type: "Address" },
      { name: "authorize", type: "bool" },
    ],
    outputs: ["void"],
  },
  {
    name: "mint",
    doc: "Mints amount to to. Requires administrator auth and is unsupported for the issuer balance.",
    inputs: [
      { name: "to", type: "Address" },
      { name: "amount", type: "i128" },
    ],
    outputs: ["void"],
  },
  {
    name: "set_admin",
    doc: "Transfers SAC administration to new_admin.",
    inputs: [{ name: "new_admin", type: "Address" }],
    outputs: ["void"],
  },
  {
    name: "admin",
    doc: "Returns the current SAC administrator.",
    inputs: [],
    outputs: ["Address"],
  },
  {
    name: "decimals",
    doc: "Returns the token decimal precision. This is fixed to 7 for SACs.",
    inputs: [],
    outputs: ["u32"],
  },
  {
    name: "name",
    doc: "Returns the asset name metadata.",
    inputs: [],
    outputs: ["String"],
  },
  {
    name: "symbol",
    doc: "Returns the asset symbol metadata.",
    inputs: [],
    outputs: ["String"],
  },
  {
    name: "trust",
    doc: "Creates the asset trustline for a classic account if needed. It is a no-op for contract addresses.",
    inputs: [{ name: "address", type: "Address" }],
    outputs: ["void"],
  },
];

const STELLAR_ASSET_BUILTIN: BuiltinContractDescriptor = {
  kind: "stellar_asset_contract",
  name: "Stellar Asset Contract",
  summary:
    "Built-in token contract for Stellar assets. Implements the common token interface plus admin operations such as clawback, authorization, mint, and admin changes.",
  sourceRefs: STELLAR_ASSET_CONTRACT_SOURCES,
  notes: [
    "SACs do not expose user-uploaded WASM spec sections; the interface comes from the host implementation.",
    "Native-asset SACs have no administrator and reject some admin or burn-style operations.",
    "The transfer function authorizes the from address, while transfer_from and burn_from authorize the spender.",
  ],
  authSemantics: [
    "Getters require no authorization.",
    "Unprivileged mutators require authorization from the balance owner or spender, depending on the function.",
    "Privileged mutators require authorization from the built-in administrator.",
  ],
  failureModes: [
    "Negative amounts map to NegativeAmountError.",
    "Missing or expired allowance maps to AllowanceError.",
    "Insufficient or invalid balance maps to BalanceError.",
    "Deauthorized balances map to BalanceDeauthorizedError.",
    "Missing trustlines on classic accounts map to TrustlineMissingError.",
    "Native-asset or issuer-restricted invalid operations map to OperationNotSupportedError.",
  ],
};

const ACCOUNT_CONTRACT_BUILTIN: BuiltinContractDescriptor = {
  kind: "account_contract",
  name: "Builtin Account Contract",
  summary:
    "Built-in account authentication contract used by the host to model classic-account auth as a generic smart wallet with __check_auth and authorization contexts.",
  sourceRefs: ACCOUNT_CONTRACT_SOURCES,
  notes: [
    "This is host-implemented auth logic, not user-uploaded WASM.",
    "It models both contract calls and create-contract host functions as authorization contexts.",
  ],
  authSemantics: [
    "__check_auth receives a signature payload, credential value, and flattened authorization contexts.",
    "Authentication succeeds only when signer weight meets the medium threshold for the classic account.",
  ],
  failureModes: [
    "No signatures, too many signatures, unordered keys, non-member signers, or insufficient weight map to AuthenticationError.",
    "Authorizing create_contract with a StellarAsset executable or asset preimage is rejected as Auth.InvalidInput.",
  ],
};

const INVOKER_CONTRACT_AUTH_BUILTIN: BuiltinContractDescriptor = {
  kind: "invoker_contract_auth",
  name: "Invoker Contract Auth",
  summary:
    "Built-in authorization format used by authorize_as_curr_contract to express sub-contract invocations and create-contract authorizations on behalf of the current contract.",
  sourceRefs: INVOKER_CONTRACT_AUTH_SOURCES,
  notes: [
    "This is an authorization data structure, not a user-facing contract.",
    "It can encode nested contract invocations and create-contract host function authorizations.",
  ],
  authSemantics: [
    "Contract-shaped entries are converted into AuthorizedInvocation trees for host auth processing.",
    "Create-contract authorization only supports Wasm executables and address-based preimages.",
  ],
  failureModes: [
    "Attempting to authorize Stellar Asset contract creation is rejected as Auth.InvalidInput.",
    "Malformed nested authorization trees fail during conversion to AuthorizedInvocation.",
  ],
};

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value && value.trim().length > 0))];
}

function includesString(value: unknown, needle: string): boolean {
  const lowerNeedle = needle.toLowerCase();
  try {
    return JSON.stringify(value).toLowerCase().includes(lowerNeedle);
  } catch {
    return false;
  }
}

function buildBuiltinInsight(
  builtin: BuiltinContractDescriptor,
  trigger: string,
  relatedFunctions: string[] = [],
  relatedCodes: string[] = [],
  debugHints: string[] = [],
): BuiltinTxInsight {
  return {
    kind: builtin.kind,
    title: builtin.name,
    summary: builtin.summary,
    trigger,
    sourceRefs: builtin.sourceRefs,
    relatedFunctions,
    relatedCodes,
    debugHints,
  };
}

function stellarAssetDebugHints(
  tx: FailedTransaction,
  contractMeta: ContractMetadata,
): string[] {
  const assetInfo = Array.isArray(contractMeta.assetMetadata?.AssetInfo)
    ? contractMeta.assetMetadata?.AssetInfo.join(", ")
    : typeof contractMeta.assetMetadata?.AssetInfo === "string"
    ? contractMeta.assetMetadata.AssetInfo
    : undefined;
  const currentFunction = uniqueStrings([
    tx.decoded.topLevelFunction,
    ...tx.decoded.invokeCalls
      .filter((call) => call.contractId === contractMeta.contractId)
      .map((call) =>
        typeof call.functionName === "string" ? call.functionName : undefined
      ),
  ]);
  const isNative = assetInfo?.toLowerCase().includes("native") ?? false;
  const hints = [
    isNative
      ? "This SAC wraps the native asset, so admin and burn-like operations can fail with OperationNotSupportedError even when the call shape is otherwise correct."
      : undefined,
    currentFunction.includes("transfer")
      ? "For transfer, the built-in contract requires authorization from the from address and may still fail for deauthorized balances or missing recipient trustlines on classic accounts."
      : undefined,
    currentFunction.includes("transfer_from") || currentFunction.includes("burn_from")
      ? "For delegated actions, verify the spender was authorized and that the allowance is both sufficient and unexpired."
      : undefined,
    currentFunction.some((name) => ["mint", "clawback", "set_admin", "set_authorized"].includes(name))
      ? "For privileged SAC operations, check the current administrator and any classic-asset flags such as clawback or authorization requirements."
      : undefined,
    currentFunction.includes("trust")
      ? "The trust function only creates classic-account trustlines; contract addresses are a no-op and reserve or subentry limits can still block creation."
      : undefined,
  ];
  return uniqueStrings(hints);
}

export function getBuiltinContractErrorEnum(): ContractErrorEnum {
  return BUILTIN_CONTRACT_ERROR_ENUM;
}

export function getStellarAssetBuiltinDescriptor(): BuiltinContractDescriptor {
  return STELLAR_ASSET_BUILTIN;
}

export function buildBuiltinStellarAssetMetadata(
  detectionReason: string,
): Pick<ContractMetadata, "builtin" | "functions" | "errorEnums" | "notes"> {
  return {
    builtin: {
      ...STELLAR_ASSET_BUILTIN,
      detectionReason,
    },
    functions: STELLAR_ASSET_FUNCTIONS,
    errorEnums: [BUILTIN_CONTRACT_ERROR_ENUM],
    notes: [
      ...(STELLAR_ASSET_BUILTIN.notes ?? []),
      `Detection: ${detectionReason}`,
    ],
  };
}

export function buildBuiltinInsights(
  tx: FailedTransaction,
  contracts?: Map<string, ContractMetadata>,
): BuiltinTxInsight[] {
  const insights: BuiltinTxInsight[] = [];

  if (contracts) {
    for (const meta of contracts.values()) {
      if (meta.builtin?.kind === STELLAR_ASSET_BUILTIN.kind) {
        insights.push(
          buildBuiltinInsight(
            meta.builtin,
            meta.builtin.detectionReason ?? "Detected built-in Stellar Asset Contract.",
            uniqueStrings([
              tx.decoded.topLevelFunction,
              ...tx.decoded.invokeCalls
                .filter((call) => call.contractId === meta.contractId)
                .map((call) =>
                  typeof call.functionName === "string" ? call.functionName : undefined
                ),
            ]),
            BUILTIN_CONTRACT_ERROR_ENUM.cases.map((entry) => entry.name),
            stellarAssetDebugHints(tx, meta),
          ),
        );
      }
    }
  }

  const invokesCheckAuth = tx.decoded.invokeCalls.some(
    (call) => call.functionName === "__check_auth",
  ) || includesString(tx.decoded.diagnosticEvents, "__check_auth");

  if (invokesCheckAuth) {
    insights.push(
      buildBuiltinInsight(
        ACCOUNT_CONTRACT_BUILTIN,
        "Detected __check_auth in the invocation trace or diagnostic events.",
        ["__check_auth"],
        ["AuthenticationError", "Auth.InvalidInput"],
        [
          "Inspect the credential payload shape and verify the signer set matches the expected account signers.",
          "If the flow authorizes create_contract, note that StellarAsset executables and asset preimages are rejected by the built-in account auth path.",
          "For classic account auth, verify signer ordering and medium-threshold weight accumulation.",
        ],
      ),
    );
  }

  const hasInvokerContractAuth = includesString(tx.decoded.authEntries, "CreateContractHostFn")
    || includesString(tx.decoded.authEntries, "CreateContractWithCtorHostFn")
    || includesString(tx.decoded.authEntries, "authorize_as_curr_contract")
    || includesString(tx.decoded.decodedEnvelope, "CreateContractHostFn");

  if (hasInvokerContractAuth) {
    insights.push(
      buildBuiltinInsight(
        INVOKER_CONTRACT_AUTH_BUILTIN,
        "Detected create-contract or authorize_as_curr_contract style authorization context.",
        ["authorize_as_curr_contract", "CreateContractHostFn", "CreateContractWithCtorHostFn"],
        ["Auth.InvalidInput"],
        [
          "Nested invoker authorization is converted into an AuthorizedInvocation tree; malformed auth structures can fail before the target contract runs.",
          "Built-in invoker auth only authorizes Wasm contract creation; Stellar Asset contract creation is explicitly rejected in this path.",
        ],
      ),
    );
  }

  return insights;
}

export function renderBuiltinSourceRefs(sourceRefs: BuiltinSourceRef[]): string[] {
  return sourceRefs.map((ref) => `${ref.label}: ${ref.url}`);
}
