import { Address, nativeToScVal, Operation, xdr } from "@stellar/stellar-sdk";

/**
 * The upto authorization the buyer signs. Every field here is covered by the
 * buyer's signature via `require_auth_for_args`; the settled amount is not, so
 * the facilitator chooses it at settle time within `maxAmount`.
 */
export interface UptoAuthorization {
  /** Buyer (payer) address, `G...`. */
  from: string;
  /** Bound recipient, `G...` — the only destination funds can reach. */
  payTo: string;
  /** SEP-41 token contract id, `C...`. */
  asset: string;
  /** Cap in atomic units. The settled amount may not exceed this. */
  maxAmount: string;
  /** Ledger before which settlement is rejected (0 for no lower bound). */
  validAfterLedger: number;
  /** Ledger after which settlement is rejected. */
  deadlineLedger: number;
  /** Allowance expiration ledger the buyer signed; replayed on-chain. */
  expirationLedger: number;
  /** 32-byte salt as hex, distinguishing otherwise-identical authorizations. */
  salt: string;
}

/**
 * The `upto` payment payload carried in `PaymentPayload.payload`. The buyer
 * builds it: the signed authorization plus a base64 `SorobanAuthorizationEntry`
 * that authorizes the settle call (amount excluded) and the nested `approve`.
 * `amount`, when present, is the actual amount the facilitator should settle;
 * it is not part of what the buyer signed.
 */
export interface UptoStellarPayload {
  authorization: UptoAuthorization;
  authEntryXdr: string;
  amount?: string;
}

const SALT_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Validates the raw payload shape and returns a typed payload, or an error
 * string describing the first problem found.
 */
export function parseUptoPayload(raw: unknown): { payload: UptoStellarPayload } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "payload must be an object" };
  const p = raw as Record<string, unknown>;

  if (typeof p.authEntryXdr !== "string" || p.authEntryXdr.length === 0) {
    return { error: "payload.authEntryXdr must be a non-empty base64 string" };
  }
  if (p.amount !== undefined && !isAtomicAmount(p.amount)) {
    return { error: "payload.amount must be a non-negative integer string" };
  }

  const a = p.authorization as Record<string, unknown> | undefined;
  if (typeof a !== "object" || a === null) return { error: "payload.authorization must be an object" };

  for (const key of ["from", "payTo", "asset"] as const) {
    if (typeof a[key] !== "string" || (a[key] as string).length === 0) {
      return { error: `payload.authorization.${key} must be a non-empty string` };
    }
  }
  if (!isAtomicAmount(a.maxAmount)) {
    return { error: "payload.authorization.maxAmount must be a non-negative integer string" };
  }
  for (const key of ["validAfterLedger", "deadlineLedger", "expirationLedger"] as const) {
    if (!Number.isInteger(a[key]) || (a[key] as number) < 0) {
      return { error: `payload.authorization.${key} must be a non-negative integer` };
    }
  }
  if (typeof a.salt !== "string" || !SALT_HEX.test(a.salt)) {
    return { error: "payload.authorization.salt must be 32 bytes of hex" };
  }

  return { payload: p as unknown as UptoStellarPayload };
}

function isAtomicAmount(v: unknown): v is string {
  return typeof v === "string" && /^\d+$/.test(v);
}

/** Builds the ordered ScVal argument list for the contract's `settle`. */
export function settleArgs(auth: UptoAuthorization, amount: bigint): xdr.ScVal[] {
  return [
    new Address(auth.from).toScVal(),
    new Address(auth.payTo).toScVal(),
    new Address(auth.asset).toScVal(),
    nativeToScVal(BigInt(auth.maxAmount), { type: "i128" }),
    nativeToScVal(auth.validAfterLedger, { type: "u32" }),
    nativeToScVal(auth.deadlineLedger, { type: "u32" }),
    nativeToScVal(auth.expirationLedger, { type: "u32" }),
    nativeToScVal(Buffer.from(auth.salt, "hex"), { type: "bytes" }),
    nativeToScVal(amount, { type: "i128" }),
  ];
}

/**
 * Builds the `settle` invoke operation. When `authEntry` is provided (settle
 * path) it is attached as the buyer's authorization; when omitted (client
 * simulation path) the host computes the required auth entries.
 */
export function settleOperation(
  contractId: string,
  auth: UptoAuthorization,
  amount: bigint,
  authEntry?: xdr.SorobanAuthorizationEntry,
): xdr.Operation {
  return Operation.invokeContractFunction({
    contract: contractId,
    function: "settle",
    args: settleArgs(auth, amount),
    ...(authEntry ? { auth: [authEntry] } : {}),
  });
}
