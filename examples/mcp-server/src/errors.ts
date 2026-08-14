/**
 * The closed set of machine-readable failure codes the tools can return.
 *
 * Split by who refused. The first group is this server rejecting before any
 * money moves; the second is the payment protocol failing somewhere upstream;
 * the third belongs to discovery. `internal_error` is the fallback that keeps
 * the "every rejection carries a code and a non-null reason" rule true even for
 * a bug we did not anticipate.
 */
export const TOOL_ERROR_CODES = [
  "cap_exceeded",
  "session_budget_exhausted",
  "asset_not_allowed",
  "network_not_supported",
  "scheme_not_supported",
  "invalid_url",
  "forbidden_header",
  "no_acceptable_payment_option",

  "payment_required_malformed",
  "verify_failed",
  "settle_failed",
  "settle_indeterminate",
  "upstream_error",
  "transport_error",

  "search_unavailable",
  "search_failed",

  "internal_error",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/**
 * A failure with a code a caller can branch on and a reason a person can read.
 *
 * When the failure came from the facilitator or the resource server, its own
 * `invalidReason` / `errorReason` string belongs in `details` untouched: our
 * code says which stage failed, theirs says why, and rewording it would break
 * the chain for anything reading the codes.
 */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    readonly reason: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(reason);
    this.name = "ToolError";
  }
}

export interface ToolErrorBody {
  error: {
    code: ToolErrorCode;
    reason: string;
    details?: Record<string, unknown>;
  };
}

/** Wraps anything thrown into the structured body, never losing the reason. */
export function toErrorBody(error: unknown): ToolErrorBody {
  if (error instanceof ToolError) {
    return {
      error: {
        code: error.code,
        reason: error.reason,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  const reason = error instanceof Error ? error.message : String(error);
  return {
    error: {
      code: "internal_error",
      reason: reason.length > 0 ? reason : "unknown failure",
    },
  };
}
