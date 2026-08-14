import { BUDGET_DECIMALS, fromAtomic } from "./assets.js";

export interface BudgetReport {
  /** Whole tokens, USD-pegged, as decimal strings. */
  perCallLimit: string;
  sessionLimit: string;
  spent: string;
  remaining: string;
}

/**
 * The session's spending ceiling, held in memory for the life of the process.
 *
 * Spend is committed the moment a payment is signed. With `upto` what gets
 * signed is a ceiling, and the seller picks the real amount afterwards, so the
 * ceiling is what the allowance has to assume until something better is known.
 *
 * It is given back only on certainty. A payment we signed and sent may settle
 * even if we never see the answer -- @x402/core says as much about a settle
 * timeout -- so releasing on a failure we cannot distinguish from a slow
 * success would let the agent spend past the ceiling while every individual
 * check passed. Overcounting a genuinely failed payment costs one call's worth
 * of allowance; undercounting costs real money.
 */
export class SessionBudget {
  #spent = 0n;

  constructor(
    private readonly perCallLimit: bigint,
    private readonly sessionLimit: bigint,
  ) {}

  get spent(): bigint {
    return this.#spent;
  }

  get remaining(): bigint {
    const left = this.sessionLimit - this.#spent;
    return left > 0n ? left : 0n;
  }

  /** Whether one payment of this size is allowed right now, and why not. */
  check(amount: bigint): { allowed: true } | { allowed: false; code: string; reason: string } {
    if (amount > this.perCallLimit) {
      return {
        allowed: false,
        code: "cap_exceeded",
        reason: `Payment of ${fromAtomic(amount, BUDGET_DECIMALS)} exceeds the per-call limit of ${fromAtomic(this.perCallLimit, BUDGET_DECIMALS)}`,
      };
    }
    if (amount > this.remaining) {
      return {
        allowed: false,
        code: "session_budget_exhausted",
        reason: `Payment of ${fromAtomic(amount, BUDGET_DECIMALS)} exceeds the ${fromAtomic(this.remaining, BUDGET_DECIMALS)} left in this session's budget of ${fromAtomic(this.sessionLimit, BUDGET_DECIMALS)}`,
      };
    }
    return { allowed: true };
  }

  /** Called once a payment has been signed, so the allowance is consumed. */
  commit(amount: bigint): void {
    this.#spent += amount;
  }

  /**
   * Reduces a committed charge to what actually settled, and answers how much
   * came back. Call it only for a settlement that definitely happened and
   * definitely named its amount: an outcome we cannot read keeps the ceiling.
   *
   * @param committed - what `commit` was called with for this payment
   * @param settled - what the facilitator reported settling
   */
  reconcile(committed: bigint, settled: bigint): bigint {
    if (settled >= committed) return 0n;

    const released = committed - settled;
    // Clamped because a caller could hand us a committed figure larger than
    // anything this session ever charged, and a negative spend would hand the
    // agent free allowance.
    this.#spent = this.#spent > released ? this.#spent - released : 0n;
    return released;
  }

  report(): BudgetReport {
    return {
      perCallLimit: fromAtomic(this.perCallLimit, BUDGET_DECIMALS),
      sessionLimit: fromAtomic(this.sessionLimit, BUDGET_DECIMALS),
      spent: fromAtomic(this.#spent, BUDGET_DECIMALS),
      remaining: fromAtomic(this.remaining, BUDGET_DECIMALS),
    };
  }
}
