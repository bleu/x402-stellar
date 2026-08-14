import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { Keypair, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { getNetworkPassphrase } from "@x402/stellar";

import { parseUptoPayload, settleOperation, type UptoAuthorization } from "../payload.js";

/**
 * The slice of a structured logger this scheme uses. Kept minimal so the
 * package does not depend on whichever logger the host application runs.
 */
export interface UptoLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

const SILENT: UptoLogger = { info: () => {}, warn: () => {} };

export interface UptoStellarSchemeOptions {
  /** Deployed UptoSettlement contract id, `C...`. */
  contractId: string;
  /** Facilitator secret key that pays fees and submits settlement. */
  facilitatorSecret: string;
  /** Soroban RPC URL. */
  rpcUrl: string;
  /** Network id, e.g. `stellar:testnet`. */
  network: Network;
  /** Max fee in stroops the facilitator will pay per settle. */
  maxTransactionFeeStroops?: number;
  /** Where settle outcomes are logged. Silent when not supplied. */
  logger?: UptoLogger;
}

/**
 * Facilitator handler for the `upto` scheme on Stellar, backed by the
 * UptoSettlement contract. Verify checks the payload against the requirements
 * and confirms the buyer's authorization simulates cleanly; settle submits the
 * settle call with the caller-supplied amount, capped by the buyer's signed
 * maxAmount, and returns the on-chain hash.
 */
export class UptoStellarScheme implements SchemeNetworkFacilitator {
  readonly scheme = "upto";
  readonly caipFamily = "stellar:*";
  readonly areFeesSponsored = true;

  private readonly contractId: string;
  private readonly facilitator: Keypair;
  private readonly server: rpc.Server;
  private readonly network: Network;
  private readonly passphrase: string;
  private readonly maxFeeStroops: number;
  private readonly logger: UptoLogger;

  constructor(options: UptoStellarSchemeOptions) {
    this.contractId = options.contractId;
    this.facilitator = Keypair.fromSecret(options.facilitatorSecret);
    this.server = new rpc.Server(options.rpcUrl);
    this.network = options.network;
    this.passphrase = getNetworkPassphrase(options.network);
    this.maxFeeStroops = options.maxTransactionFeeStroops ?? 100_000;
    this.logger = options.logger ?? SILENT;
  }

  getExtra(): Record<string, unknown> | undefined {
    return { areFeesSponsored: this.areFeesSponsored, contract: this.contractId };
  }

  getSigners(): string[] {
    return [this.facilitator.publicKey()];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const parsed = parseUptoPayload(payload.payload);
    if ("error" in parsed) {
      return invalid("invalid_payload", parsed.error);
    }
    const { authorization: auth, authEntryXdr } = parsed.payload;

    const mismatch = this.checkRequirements(payload, auth, requirements);
    if (mismatch) return mismatch;

    const amount = this.resolveAmount(parsed.payload);
    if (amount === undefined) {
      return invalid("amount_exceeds_max", "settle amount exceeds the signed maxAmount");
    }

    const window = await this.checkWindow(auth);
    if (window) return window;

    // Simulate the settle with the buyer's signed auth entry. A clean
    // simulation proves the authorization is well-formed, signed by the payer,
    // and sufficient for this amount without submitting anything.
    try {
      const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");
      const sim = await this.simulate(auth, amount, authEntry);
      if (rpc.Api.isSimulationError(sim)) {
        return invalid("authorization_invalid", sim.error);
      }
    } catch (error) {
      return invalid(
        "authorization_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }

    return { isValid: true, payer: auth.from };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const parsed = parseUptoPayload(payload.payload);
    if ("error" in parsed) {
      return this.settleFailure("invalid_payload", parsed.error);
    }
    const { authorization: auth, authEntryXdr } = parsed.payload;

    const mismatch = this.checkRequirements(payload, auth, requirements);
    if (mismatch) {
      return this.settleFailure(
        mismatch.invalidReason ?? "requirements_mismatch",
        mismatch.invalidMessage,
      );
    }

    const amount = this.resolveAmount(parsed.payload);
    if (amount === undefined) {
      return this.settleFailure("amount_exceeds_max", "settle amount exceeds the signed maxAmount");
    }

    const window = await this.checkWindow(auth);
    if (window) {
      return this.settleFailure(window.invalidReason ?? "expired", window.invalidMessage);
    }

    try {
      const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");
      const sim = await this.simulate(auth, amount, authEntry);
      if (rpc.Api.isSimulationError(sim)) {
        return this.settleFailure("authorization_invalid", sim.error);
      }

      const account = await this.server.getAccount(this.facilitator.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: this.maxFeeStroops.toString(),
        networkPassphrase: this.passphrase,
      })
        .addOperation(settleOperation(this.contractId, auth, amount, authEntry))
        .setTimeout(120)
        .build();

      const prepared = rpc.assembleTransaction(tx, sim).build();
      prepared.sign(this.facilitator);

      const sent = await this.server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        return this.settleFailure("submit_failed", JSON.stringify(sent.errorResult));
      }
      const result = await this.server.pollTransaction(sent.hash, { attempts: 30 });
      if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        return this.settleFailure("settlement_failed", `transaction ${result.status}`);
      }

      this.logger.info(
        { hash: sent.hash, amount: amount.toString(), payer: auth.from },
        "upto settled",
      );
      return {
        success: true,
        transaction: sent.hash,
        network: this.network,
        payer: auth.from,
        amount: amount.toString(),
      };
    } catch (error) {
      return this.settleFailure(
        "settlement_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private simulate(
    auth: UptoAuthorization,
    amount: bigint,
    authEntry: xdr.SorobanAuthorizationEntry,
  ) {
    return this.server.getAccount(this.facilitator.publicKey()).then((account) => {
      const tx = new TransactionBuilder(account, {
        fee: this.maxFeeStroops.toString(),
        networkPassphrase: this.passphrase,
      })
        .addOperation(settleOperation(this.contractId, auth, amount, authEntry))
        .setTimeout(120)
        .build();
      return this.server.simulateTransaction(tx);
    });
  }

  private checkRequirements(
    payload: PaymentPayload,
    auth: UptoAuthorization,
    requirements: PaymentRequirements,
  ): VerifyResponse | undefined {
    if (requirements.scheme !== "upto" || payload.accepted.scheme !== "upto") {
      return invalid("unsupported_scheme", `expected upto, got ${requirements.scheme}`);
    }
    if (requirements.network !== payload.accepted.network) {
      return invalid("network_mismatch", "accepted network does not match requirements");
    }
    if (auth.asset !== requirements.asset) {
      return invalid("asset_mismatch", "authorization asset does not match requirements");
    }
    if (auth.payTo !== requirements.payTo) {
      return invalid("recipient_mismatch", "authorization payTo does not match requirements");
    }
    if (auth.maxAmount !== requirements.amount) {
      return invalid("cap_mismatch", "authorization maxAmount does not match requirements amount");
    }
    return undefined;
  }

  private async checkWindow(auth: UptoAuthorization): Promise<VerifyResponse | undefined> {
    const { sequence } = await this.server.getLatestLedger();
    if (sequence < auth.validAfterLedger) {
      return invalid("not_yet_valid", `ledger ${sequence} < validAfter ${auth.validAfterLedger}`);
    }
    if (sequence > auth.deadlineLedger) {
      return invalid("expired", `ledger ${sequence} > deadline ${auth.deadlineLedger}`);
    }
    return undefined;
  }

  /** Actual settle amount, defaulting to the cap; undefined when it exceeds the cap. */
  private resolveAmount(payload: {
    authorization: UptoAuthorization;
    amount?: string;
  }): bigint | undefined {
    const cap = BigInt(payload.authorization.maxAmount);
    const amount = payload.amount === undefined ? cap : BigInt(payload.amount);
    if (amount < 0n || amount > cap) return undefined;
    return amount;
  }

  private settleFailure(reason: string, message?: string): SettleResponse {
    this.logger.warn({ reason, message }, "upto settle failed");
    return {
      success: false,
      transaction: "",
      network: this.network,
      errorReason: reason,
      errorMessage: message,
    };
  }
}

function invalid(reason: string, message: string): VerifyResponse {
  return { isValid: false, invalidReason: reason, invalidMessage: message };
}
