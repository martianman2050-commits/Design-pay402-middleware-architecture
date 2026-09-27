// BigInt-only amount handling. Number()/parseFloat()/parseInt() are banned
// across src/ by eslint.config.js — every conversion here is string + BigInt
// integer math.

/**
 * Explicit, unit-tagged price input. Bare numbers or ambiguous strings are
 * rejected by parsePriceToAtomic — no silent unit inference, ever.
 */
export type PriceInput = `$${string}` | { amount: string; unit: "atomic" };

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

const INTEGER_STRING = /^\d+$/;
const DOLLAR_STRING = /^\$(\d+)(?:\.(\d+))?$/;

/**
 * Convert an explicit price to atomic units using integer math only.
 *
 * - "$12.34" with decimals=6 → 12340000n
 * - { amount: "10000", unit: "atomic" } → 10000n
 * - anything else (bare number, "12.34", "10000") throws AmountError.
 *
 * Fractional digits beyond `decimals` throw rather than truncate: silently
 * dropping precision on money is not acceptable.
 */
export function parsePriceToAtomic(price: PriceInput, decimals: number): bigint {
  if (!INTEGER_STRING.test(String(decimals)) || decimals < 0) {
    throw new AmountError(`decimals must be a non-negative integer, got: ${decimals}`);
  }
  if (typeof price === "object" && price !== null && price.unit === "atomic") {
    if (typeof price.amount !== "string" || !INTEGER_STRING.test(price.amount)) {
      throw new AmountError(
        `atomic amount must be a non-negative integer string, got: ${JSON.stringify(price.amount)}`,
      );
    }
    const atomic = BigInt(price.amount);
    if (atomic <= 0n) {
      throw new AmountError(`atomic amount must be > 0, got: ${price.amount}`);
    }
    return atomic;
  }
  if (typeof price === "string") {
    const m = DOLLAR_STRING.exec(price);
    if (!m) {
      throw new AmountError(
        `dollar price must match $<int>[.<frac>] (e.g. "$0.01"), got: ${JSON.stringify(price)}`,
      );
    }
    const intPart = m[1] ?? "0";
    const fracPart = m[2] ?? "";
    if (fracPart.length > decimals) {
      throw new AmountError(
        `price ${price} has ${fracPart.length} fractional digits; asset supports max ${decimals}`,
      );
    }
    const fracPadded = fracPart.padEnd(decimals, "0");
    const atomic = BigInt(intPart + fracPadded);
    if (atomic <= 0n) {
      throw new AmountError(`price must be > 0, got: ${price}`);
    }
    return atomic;
  }
  // Catches bare numbers and any other shape at runtime despite the type —
  // JS callers can pass anything. No unit guessing: throw.
  throw new AmountError(
    `price must be a "$"-prefixed string or { amount: string, unit: "atomic" }, got: ${JSON.stringify(price)} (${typeof price})`,
  );
}

/** Validate that a string is a non-negative integer (atomic-unit) string. */
export function isAtomicString(value: unknown): value is string {
  return typeof value === "string" && INTEGER_STRING.test(value);
}

/** Parse an atomic-unit integer string to BigInt, or throw. */
export function parseAtomicString(value: string): bigint {
  if (!isAtomicString(value)) {
    throw new AmountError(`not an atomic integer string: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** Render an atomic amount as its canonical integer string (BigInt-safe). */
export function formatAtomic(atomic: bigint): string {
  return atomic.toString();
}

/**
 * Sum atomic amounts given as integer strings. Returns the exact string sum.
 * Throws on any non-integer-string entry — no coercion, no floats.
 */
export function sumAtomicStrings(amounts: readonly string[]): string {
  let total = 0n;
  for (const a of amounts) {
    total += parseAtomicString(a);
  }
  return total.toString();
}
