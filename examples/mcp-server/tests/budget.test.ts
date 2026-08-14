import { describe, expect, it } from "vitest";

import { BUDGET_DECIMALS, toAtomic } from "../src/assets.js";
import { SessionBudget } from "../src/budget.js";

function budget(perCall = "0.01", session = "0.05"): SessionBudget {
  return new SessionBudget(toAtomic(perCall, BUDGET_DECIMALS), toAtomic(session, BUDGET_DECIMALS));
}

const CAP = toAtomic("0.003", BUDGET_DECIMALS);
const SETTLED = toAtomic("0.001", BUDGET_DECIMALS);

describe("SessionBudget reserve and reconcile", () => {
  it("charges the whole ceiling the moment a payment is signed", () => {
    const session = budget();

    session.commit(CAP);

    expect(session.spent).toBe(CAP);
  });

  it("gives back the difference once a smaller amount is known to have settled", () => {
    const session = budget();
    session.commit(CAP);

    const released = session.reconcile(CAP, SETTLED);

    expect(released).toBe(CAP - SETTLED);
    expect(session.spent).toBe(SETTLED);
  });

  it("gives nothing back when the whole ceiling settled", () => {
    const session = budget();
    session.commit(CAP);

    const released = session.reconcile(CAP, CAP);

    expect(released).toBe(0n);
    expect(session.spent).toBe(CAP);
  });

  it("never gives back more than it charged, whatever the settlement claims", () => {
    const session = budget();
    session.commit(CAP);

    const released = session.reconcile(CAP, CAP * 10n);

    expect(released).toBe(0n);
    expect(session.spent).toBe(CAP);
  });

  it("leaves other calls' spend alone when one of them settles short", () => {
    const session = budget();
    session.commit(CAP);
    session.commit(CAP);

    session.reconcile(CAP, SETTLED);

    expect(session.spent).toBe(CAP + SETTLED);
  });

  it("cannot drive the session's spend below zero", () => {
    const session = budget();
    session.commit(SETTLED);

    session.reconcile(CAP, 0n);

    expect(session.spent).toBe(0n);
  });
});
