/**
 * What the upto weather route actually charges, once it knows which city was
 * asked for. The buyer signed a ceiling; this picks the number under it.
 */

/**
 * Cities this route treats as premium. Short and fixed, so a demo can show the
 * same city charging the same amount every time.
 */
const PREMIUM_CITIES = new Set(["tokyo", "london", "new york", "san francisco", "singapore"]);

/**
 * Atomic USDC, at Stellar's seven decimals: the whole 0.003 ceiling, and a
 * third of it.
 *
 * Nothing at runtime holds these under the ceiling. Core passes a settlement
 * override straight through, so only the facilitator's range check and the
 * contract would catch a number above it. A test ties them to the quoted cap.
 */
export const UPTO_PREMIUM_ATOMIC = "30000";
export const UPTO_STANDARD_ATOMIC = "10000";

export function uptoSettlementAmount(city: string): string {
  return PREMIUM_CITIES.has(city.trim().toLowerCase()) ? UPTO_PREMIUM_ATOMIC : UPTO_STANDARD_ATOMIC;
}
