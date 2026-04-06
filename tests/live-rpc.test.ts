import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  rpc,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { buildRpcUrl } from "../src/rpc.js";

vi.mock("../src/xdr.js", () => ({
  deepDecodeXdr: (value: unknown) => value,
}));

interface LiveConfig {
  endpoint: string;
  token: string;
  authMode: "header" | "path";
  sourceSecret?: string;
}

function getLiveConfig(): LiveConfig | null {
  const token = process.env.STELLAR_ARCHIVE_RPC_TOKEN ||
    process.env.LIVE_RPC_TOKEN ||
    "";
  const endpoint = process.env.STELLAR_RPC_ENDPOINT ||
    process.env.LIVE_RPC_ENDPOINT ||
    "https://rpc-pro.lightsail.network";
  const authMode = process.env.STELLAR_RPC_AUTH_MODE === "path" ||
      process.env.LIVE_RPC_AUTH_MODE === "path"
    ? "path"
    : "header";
  const sourceSecret = process.env.LIVE_RPC_SOURCE_SECRET;

  if (!token.trim()) return null;
  return { endpoint, token, authMode, sourceSecret };
}

async function postRpc(
  config: LiveConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const url = buildRpcUrl(config.endpoint, config.token, config.authMode);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.authMode === "header"
        ? { Authorization: `Bearer ${config.token}` }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method,
      params,
    }),
  });

  const json = await response.json();
  return { status: response.status, json };
}

function makeRandomContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

async function writeObservation(
  network: string,
  name: string,
  value: unknown,
): Promise<void> {
  const dir = join(process.cwd(), ".context", "live-rpc-observations", network);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.json`),
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

const config = getLiveConfig();
const live = config !== null;

if (config) {
  describe("live rpc matrix", () => {
    const cfg = config;
    const server = new rpc.Server(
      buildRpcUrl(cfg.endpoint, cfg.token, cfg.authMode),
      {
        headers: cfg.authMode === "header"
          ? { Authorization: `Bearer ${cfg.token}` }
          : undefined,
        allowHttp: false,
      },
    );

  let networkPassphrase = "";
  let networkName = "unknown-network";
  let accountKeypair: Keypair;
  let account: Account;

  async function ensureFundedAccount(): Promise<{ keypair: Keypair; account: Account }> {
    if (cfg.sourceSecret) {
      const keypair = Keypair.fromSecret(cfg.sourceSecret);
      const fetched = await server.getAccount(keypair.publicKey());
      return { keypair, account: fetched };
    }

    const network = await server.getNetwork();
    if (!network.friendbotUrl) {
      throw new Error(
        "No friendbotUrl advertised by the RPC network. Set LIVE_RPC_SOURCE_SECRET to run live send/simulate tests.",
      );
    }

    const keypair = Keypair.random();
    await server.fundAddress(keypair.publicKey(), network.friendbotUrl);
    const fetched = await server.getAccount(keypair.publicKey());
    return { keypair, account: fetched };
  }

  function buildSelfPaymentTx(accountForBuild: Account, opts: {
    sign?: boolean;
    timeout?: number;
    maxTime?: string;
    sequenceOffset?: number;
    fee?: string;
  } = {}) {
    const sequenceOffset = opts.sequenceOffset ?? 0;
    const baseSeq = BigInt(accountForBuild.sequenceNumber());
    const builderAccount = new Account(
      accountForBuild.accountId(),
      (baseSeq + BigInt(sequenceOffset)).toString(),
    );
    const builder = new TransactionBuilder(builderAccount, {
      fee: opts.fee ?? BASE_FEE,
      networkPassphrase,
    })
      .addOperation(Operation.payment({
        destination: accountForBuild.accountId(),
        asset: Asset.native(),
        amount: "1",
      }));

    if (opts.maxTime) {
      builder.setTimebounds(0, opts.maxTime);
    } else {
      builder.setTimeout(opts.timeout ?? 30);
    }

    const tx = builder.build();
    if (opts.sign !== false) {
      tx.sign(accountKeypair);
    }
    return tx;
  }

  beforeAll(async () => {
    const network = await server.getNetwork();
    networkPassphrase = network.passphrase;
    networkName = network.passphrase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const funded = await ensureFundedAccount();
    accountKeypair = funded.keypair;
    account = funded.account;

    await writeObservation(networkName, "network", network);
  }, 60_000);

  it("captures a real simulation error for a missing contract", async () => {
    const { buildFailedTransactionFromDirectError } = await import("../src/direct.js");
    const missingContract = new Contract(makeRandomContractId());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(missingContract.call("missing"))
      .setTimeout(30)
      .build();

    const raw = await postRpc(cfg, "simulateTransaction", {
      transaction: tx.toEnvelope().toXDR("base64"),
    });
    await writeObservation(networkName, "simulate-missing-contract-raw", raw);

    expect(raw.status).toBe(200);
    expect(raw.json.result.latestLedger).toEqual(expect.any(Number));
    expect(raw.json.result.error).toEqual(expect.any(String));

    const normalized = await buildFailedTransactionFromDirectError({
      kind: "rpc_simulate",
      transactionXdr: tx.toEnvelope().toXDR("base64"),
      response: raw.json.result,
      sourceLabel: "live-rpc-test:simulate-missing-contract",
    });
    await writeObservation(networkName, "simulate-missing-contract-normalized", normalized);

    expect(normalized.observationKind).toBe("rpc_simulate");
    expect(normalized.readout.simulationError).toEqual(expect.any(String));
    expect(normalized.resultKind.startsWith("simulate:")).toBe(true);
  }, 60_000);

  it("captures a real sendTransaction fast failure for unsigned tx_bad_auth-style rejection", async () => {
    const { buildFailedTransactionFromDirectError } = await import("../src/direct.js");
    const tx = buildSelfPaymentTx(account, { sign: false });
    const raw = await postRpc(cfg, "sendTransaction", {
      transaction: tx.toEnvelope().toXDR("base64"),
    });
    await writeObservation(networkName, "send-unsigned-raw", raw);

    expect(raw.status).toBe(200);
    expect(raw.json.result.hash).toEqual(expect.any(String));
    expect(raw.json.result.status).toBe("ERROR");
    expect(raw.json.result.errorResultXdr).toEqual(expect.any(String));

    const normalized = await buildFailedTransactionFromDirectError({
      kind: "rpc_send",
      transactionXdr: tx.toEnvelope().toXDR("base64"),
      response: raw.json.result,
      sourceLabel: "live-rpc-test:send-unsigned",
    });
    await writeObservation(networkName, "send-unsigned-normalized", normalized);

    expect(normalized.observationKind).toBe("rpc_send");
    expect(normalized.readout.rpcStatus).toBe("ERROR");

    const lookup = await postRpc(cfg, "getTransaction", {
      hash: raw.json.result.hash,
    });
    await writeObservation(networkName, "send-unsigned-get-transaction", lookup);
  }, 60_000);

  it("captures a real sendTransaction fast failure for bad sequence", async () => {
    const { buildFailedTransactionFromDirectError } = await import("../src/direct.js");
    const freshAccount = await server.getAccount(account.accountId());
    const tx = buildSelfPaymentTx(freshAccount, { sequenceOffset: -1 });
    const raw = await postRpc(cfg, "sendTransaction", {
      transaction: tx.toEnvelope().toXDR("base64"),
    });
    await writeObservation(networkName, "send-bad-seq-raw", raw);

    expect(raw.status).toBe(200);
    expect(raw.json.result.status).toBe("ERROR");
    expect(raw.json.result.errorResultXdr).toEqual(expect.any(String));

    const normalized = await buildFailedTransactionFromDirectError({
      kind: "rpc_send",
      transactionXdr: tx.toEnvelope().toXDR("base64"),
      response: raw.json.result,
      sourceLabel: "live-rpc-test:send-bad-seq",
    });
    await writeObservation(networkName, "send-bad-seq-normalized", normalized);

    expect(normalized.resultKind).toBe("tx_bad_seq");
  }, 60_000);

  it("captures a real sendTransaction fast failure for expired timebounds", async () => {
    const { buildFailedTransactionFromDirectError } = await import("../src/direct.js");
    const freshAccount = await server.getAccount(account.accountId());
    const tx = buildSelfPaymentTx(freshAccount, { maxTime: "1" });
    const raw = await postRpc(cfg, "sendTransaction", {
      transaction: tx.toEnvelope().toXDR("base64"),
    });
    await writeObservation(networkName, "send-expired-raw", raw);

    expect(raw.status).toBe(200);
    expect(["ERROR", "PENDING"]).toContain(raw.json.result.status);
    expect(raw.json.result.hash).toEqual(expect.any(String));

    if (raw.json.result.status === "PENDING") {
      const lookup = await postRpc(cfg, "getTransaction", {
        hash: raw.json.result.hash,
      });
      await writeObservation(networkName, "send-expired-get-transaction", lookup);
      return;
    }

    expect(raw.json.result.errorResultXdr).toEqual(expect.any(String));

    const normalized = await buildFailedTransactionFromDirectError({
      kind: "rpc_send",
      transactionXdr: tx.toEnvelope().toXDR("base64"),
      response: raw.json.result,
      sourceLabel: "live-rpc-test:send-expired",
    });
    await writeObservation(networkName, "send-expired-normalized", normalized);

    expect(normalized.readout.rpcStatus).toBe("ERROR");
  }, 60_000);
  });
}

describe("live rpc matrix prerequisites", () => {
  it("documents why the live suite is skipped when no token is configured", () => {
    if (live) return;
    expect(getLiveConfig()).toBeNull();
  });
});
