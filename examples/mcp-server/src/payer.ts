import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements, SchemeNetworkClient, SettleResponse } from "@x402/core/types";
import { FacilitatorTimeoutError, SettleError, VerifyError } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";

import type { PaymentAbility } from "./ability.js";
import { fromAtomic, parseAtomicAmount, toBudgetUnits, type PayableAsset } from "./assets.js";
import type { BudgetReport, SessionBudget } from "./budget.js";
import { ToolError, type ToolErrorCode } from "./errors.js";
import { logger } from "./logger.js";

/** Headers a caller may never set: they would forge or corrupt the payment. */
const FORBIDDEN_HEADERS = new Set([
  "payment-signature",
  "payment-required",
  "payment-response",
  "x-payment",
  "x-payment-response",
  "host",
  "content-length",
]);

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/** Bodies larger than this are truncated before reaching the model's context. */
const MAX_BODY_CHARS = 8000;

export interface PaidRequestInput {
  url: string;
  method?: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface PaidRequestOutput {
  url: string;
  status: number;
  contentType?: string;
  body: unknown;
  truncated?: boolean;
  paid: boolean;
  settlement?: {
    success: boolean;
    transaction?: string;
    network?: string;
    payer?: string;
    explorerUrl?: string;
    amountAtomic?: string;
    asset?: string;
    usd?: string;
  };
  budget: BudgetReport;
}

export interface PayerConfig {
  network: `${string}:${string}`;
  ability: PaymentAbility;
  budget: SessionBudget;
  /** Builds the scheme client that signs. Injected so tests need no key. */
  createSchemeClient: () => SchemeNetworkClient;
  fetchImpl: typeof globalThis.fetch;
  explorerBaseUrl?: string;
}

/** State for one paid_request call, so hooks can report why they refused. */
interface CallContext {
  refusal?: ToolError;
  signed?: { amountAtomic: bigint; asset: PayableAsset; requirements: PaymentRequirements };
  /**
   * What the 402 offered. The client throws on an unregistered network or
   * scheme before any policy or hook of ours runs, so without this the refusal
   * could not say which of the two was actually wrong.
   */
  offered?: PaymentRequirements[];
}

function assertUsableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError("invalid_url", `"${raw}" is not an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError("invalid_url", `Only http and https are supported, got "${url.protocol}"`);
  }
  return url;
}

function assertUsableHeaders(headers: Record<string, string> | undefined): void {
  for (const name of Object.keys(headers ?? {})) {
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new ToolError(
        "forbidden_header",
        `Header "${name}" is set by the payment layer and cannot be supplied by the caller`,
      );
    }
  }
}

function readSettlement(response: Response): SettleResponse | undefined {
  const raw =
    response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  if (!raw) return undefined;
  try {
    return decodePaymentResponseHeader(raw);
  } catch (error) {
    logger.warn({ err: error }, "Malformed PAYMENT-RESPONSE header");
    return undefined;
  }
}

async function readBody(response: Response): Promise<{ body: unknown; truncated: boolean }> {
  const text = await response.text();
  const truncated = text.length > MAX_BODY_CHARS;
  const kept = truncated ? text.slice(0, MAX_BODY_CHARS) : text;

  if ((response.headers.get("content-type") ?? "").includes("application/json") && !truncated) {
    try {
      return { body: JSON.parse(kept), truncated };
    } catch {
      // Fall through to text: a malformed JSON body is still worth showing.
    }
  }
  return { body: kept, truncated };
}

/**
 * Classifies a thrown payment failure.
 *
 * A refusal recorded by our own hooks wins, because the wrapper rewraps hook
 * aborts into a generic "Failed to create payment payload" message and the code
 * would otherwise be lost. After that, anything thrown once a payment was signed
 * is indeterminate rather than failed: the payment was already on its way.
 */
function classify(
  error: unknown,
  context: CallContext,
  config: Pick<PayerConfig, "network" | "ability">,
): ToolError {
  if (context.refusal) return context.refusal;

  if (error instanceof VerifyError) {
    return new ToolError("verify_failed", error.message, {
      ...(error.invalidReason ? { invalidReason: error.invalidReason } : {}),
      ...(error.invalidMessage ? { invalidMessage: error.invalidMessage } : {}),
      ...(error.payer ? { payer: error.payer } : {}),
    });
  }

  if (error instanceof SettleError) {
    return new ToolError("settle_failed", error.message, {
      ...(error.errorReason ? { errorReason: error.errorReason } : {}),
      ...(error.errorMessage ? { errorMessage: error.errorMessage } : {}),
      transaction: error.transaction,
      network: error.network,
    });
  }

  const message = error instanceof Error ? error.message : String(error);

  // Thrown by the client before any policy or hook of ours runs, and it uses one
  // message for both an unknown network and an unknown scheme. The 402 we
  // recorded says which it really was, so the agent is not told the wrong thing.
  if (message.includes("No network/scheme registered")) {
    const offered = context.offered ?? [];
    const onOurNetwork = offered.filter((option) => option.network === config.network);
    const details = {
      offered: offered.map((option) => `${option.scheme} on ${option.network}`),
    };

    if (onOurNetwork.length > 0) {
      return new ToolError(
        "scheme_not_supported",
        `The resource asks for a payment scheme this wallet cannot sign. It holds ${config.ability.describe()}.`,
        details,
      );
    }
    return new ToolError(
      "network_not_supported",
      `The resource offered no payment option on ${config.network}`,
      details,
    );
  }

  if (message.includes("filtered out by policies")) {
    return new ToolError(
      "no_acceptable_payment_option",
      "None of the resource's payment options are acceptable to this wallet",
    );
  }

  if (error instanceof FacilitatorTimeoutError || context.signed) {
    return new ToolError(
      "settle_indeterminate",
      `The payment was signed and sent but the outcome is unknown: ${message}. It may have settled; the session budget has been charged for it.`,
    );
  }

  if (message.includes("Failed to parse payment requirements")) {
    return new ToolError("payment_required_malformed", message);
  }

  return new ToolError("transport_error", message);
}

/**
 * Runs one 402 -> sign -> retry cycle for the agent.
 *
 * Guards live in the client's own hooks rather than around them so they bind to
 * the option actually selected: the asset policy filters what may be chosen, the
 * pre-creation hook aborts when the price is over budget, and the post-creation
 * hook charges the budget the instant a payment is signed.
 */
export function createPayer(config: PayerConfig) {
  return async function pay(input: PaidRequestInput): Promise<PaidRequestOutput> {
    const url = assertUsableUrl(input.url);
    assertUsableHeaders(input.headers);

    const method = (input.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new ToolError("invalid_url", `Method "${method}" is not supported`);
    }

    for (const [key, value] of Object.entries(input.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const context: CallContext = {};

    // Records what the 402 offered on its way past. Headers only, so the body
    // the wrapper reads next is untouched.
    const observingFetch: typeof globalThis.fetch = async (target, init) => {
      const response = await config.fetchImpl(target, init);
      if (response.status === 402) {
        const header =
          response.headers.get("PAYMENT-REQUIRED") ?? response.headers.get("X-PAYMENT-REQUIRED");
        if (header) {
          try {
            context.offered = decodePaymentRequiredHeader(header).accepts;
          } catch (error) {
            logger.debug({ err: error }, "Could not decode PAYMENT-REQUIRED for diagnostics");
          }
        }
      }
      return response;
    };

    const client = new x402Client()
      .register(config.network, config.createSchemeClient())
      .registerPolicy((_version, requirements) => {
        // Only reached with a non-empty list: the client throws on its own when
        // no option matches a registered network and scheme.
        const payable = requirements.filter((option) => config.ability.canPay(option));

        if (payable.length === 0) {
          context.refusal = new ToolError(
            "asset_not_allowed",
            `The resource asks for payment in an asset this wallet does not hold. It holds ${config.ability.describe()}.`,
            { offered: requirements.map((option) => `${option.asset} on ${option.network}`) },
          );
        }
        return payable;
      })
      .onBeforePaymentCreation(async ({ selectedRequirements }) => {
        const declared = config.ability.canPay(selectedRequirements)
          ? config.ability.assetFor(selectedRequirements)
          : undefined;
        if (!declared) {
          context.refusal = new ToolError(
            "asset_not_allowed",
            `Selected option pays in ${selectedRequirements.asset}, which is not payable. This wallet holds ${config.ability.describe()}.`,
          );
          return { abort: true, reason: context.refusal.reason };
        }

        let atomic: bigint;
        try {
          atomic = parseAtomicAmount(selectedRequirements.amount);
        } catch (error) {
          // Recorded, not thrown: the wrapper would flatten it into a generic
          // "failed to create payment payload" and the code would be lost.
          context.refusal =
            error instanceof ToolError
              ? error
              : new ToolError("payment_required_malformed", String(error));
          return { abort: true, reason: context.refusal.reason };
        }

        const verdict = config.budget.check(toBudgetUnits(atomic, declared.decimals));
        if (!verdict.allowed) {
          context.refusal = new ToolError(verdict.code as ToolErrorCode, verdict.reason, {
            quote: {
              amountAtomic: selectedRequirements.amount,
              asset: selectedRequirements.asset,
              network: selectedRequirements.network,
              usd: fromAtomic(atomic, declared.decimals),
            },
            budget: config.budget.report(),
          });
          return { abort: true, reason: verdict.reason };
        }
        return undefined;
      })
      .onAfterPaymentCreation(async ({ selectedRequirements }) => {
        const declared = config.ability.assetFor(selectedRequirements);
        if (!declared) return;

        const atomic = parseAtomicAmount(selectedRequirements.amount);
        // Charged here, at signing, and never released. See SessionBudget.
        config.budget.commit(toBudgetUnits(atomic, declared.decimals));
        context.signed = {
          amountAtomic: atomic,
          asset: declared,
          requirements: selectedRequirements,
        };
      });

    const payingFetch = wrapFetchWithPayment(observingFetch, client);

    let response: Response;
    try {
      response = await payingFetch(url.toString(), {
        method,
        headers: {
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
          ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(input.headers ?? {}),
        },
        ...(input.body !== undefined && method !== "GET" && method !== "HEAD"
          ? { body: typeof input.body === "string" ? input.body : JSON.stringify(input.body) }
          : {}),
      });
    } catch (error) {
      throw classify(error, context, config);
    }

    const settlement = readSettlement(response);
    const { body, truncated } = await readBody(response);

    if (!response.ok) {
      // A second 402 means the payment was rejected at verify time.
      const code: ToolErrorCode = response.status === 402 ? "verify_failed" : "upstream_error";
      throw new ToolError(
        code,
        `The resource returned ${response.status} after payment${settlement?.errorReason ? `: ${settlement.errorReason}` : ""}`,
        {
          status: response.status,
          ...(settlement?.errorReason ? { errorReason: settlement.errorReason } : {}),
          body,
          budget: config.budget.report(),
          ...(context.signed ? { paymentWasSigned: true } : {}),
        },
      );
    }

    if (settlement && settlement.success === false) {
      throw new ToolError(
        "settle_failed",
        `Settlement failed${settlement.errorReason ? `: ${settlement.errorReason}` : ""}`,
        {
          ...(settlement.errorReason ? { errorReason: settlement.errorReason } : {}),
          ...(settlement.transaction ? { transaction: settlement.transaction } : {}),
          network: settlement.network,
          budget: config.budget.report(),
        },
      );
    }

    return {
      url: url.toString(),
      status: response.status,
      ...(response.headers.get("content-type")
        ? { contentType: response.headers.get("content-type") as string }
        : {}),
      body,
      ...(truncated ? { truncated: true } : {}),
      paid: context.signed !== undefined,
      ...(settlement
        ? {
            settlement: {
              success: settlement.success,
              ...(settlement.transaction ? { transaction: settlement.transaction } : {}),
              ...(settlement.network ? { network: settlement.network } : {}),
              ...(settlement.payer ? { payer: settlement.payer } : {}),
              ...(config.explorerBaseUrl && settlement.transaction
                ? { explorerUrl: `${config.explorerBaseUrl}/${settlement.transaction}` }
                : {}),
              ...(context.signed
                ? {
                    amountAtomic: context.signed.amountAtomic.toString(),
                    asset: context.signed.asset.asset,
                    usd: fromAtomic(context.signed.amountAtomic, context.signed.asset.decimals),
                  }
                : {}),
            },
          }
        : {}),
      budget: config.budget.report(),
    };
  };
}
