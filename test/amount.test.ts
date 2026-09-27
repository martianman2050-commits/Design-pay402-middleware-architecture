import { describe, expect, it } from "vitest";
import {
  AmountError,
  formatAtomic,
  isAtomicString,
  parseAtomicString,
  parsePriceToAtomic,
  sumAtomicStrings,
} from "../src/amount.js";

describe("parsePriceToAtomic — dollar prices (integer math only)", () => {
  it("converts $0.01 with 6 decimals to exactly 10000n", () => {
    expect(parsePriceToAtomic("$0.01", 6)).toBe(10000n);
  });

  it("converts $12.345678 with 6 decimals to 12345678n", () => {
    expect(parsePriceToAtomic("$12.345678", 6)).toBe(12345678n);
  });

  it("converts whole dollars $3 to 3000000n", () => {
    expect(parsePriceToAtomic("$3", 6)).toBe(3000000n);
  });

  it("pads short fractions: $0.1 → 100000n", () => {
    expect(parsePriceToAtomic("$0.1", 6)).toBe(100000n);
  });

  it("throws on more fractional digits than decimals (no silent truncation)", () => {
    expect(() => parsePriceToAtomic("$0.0000001", 6)).toThrow(AmountError);
  });

  it("throws on $0 (price must be > 0)", () => {
    expect(() => parsePriceToAtomic("$0", 6)).toThrow(AmountError);
    expect(() => parsePriceToAtomic("$0.000000", 6)).toThrow(AmountError);
  });
});

describe("parsePriceToAtomic — explicit atomic amounts", () => {
  it("accepts { amount: '10000', unit: 'atomic' }", () => {
    expect(parsePriceToAtomic({ amount: "10000", unit: "atomic" }, 6)).toBe(10000n);
  });

  it("throws on non-integer atomic strings", () => {
    expect(() => parsePriceToAtomic({ amount: "1.5", unit: "atomic" }, 6)).toThrow(AmountError);
    expect(() => parsePriceToAtomic({ amount: "-100", unit: "atomic" }, 6)).toThrow(AmountError);
    expect(() => parsePriceToAtomic({ amount: "0x10", unit: "atomic" }, 6)).toThrow(AmountError);
  });

  it("throws on zero atomic amount", () => {
    expect(() => parsePriceToAtomic({ amount: "0", unit: "atomic" }, 6)).toThrow(AmountError);
  });
});

describe("parsePriceToAtomic — no silent unit inference", () => {
  it("throws on bare number input (JS caller bypassing types)", () => {
    expect(() => parsePriceToAtomic(0.01 as never, 6)).toThrow(AmountError);
    expect(() => parsePriceToAtomic(10000 as never, 6)).toThrow(AmountError);
  });

  it("throws on ambiguous bare string input", () => {
    expect(() => parsePriceToAtomic("0.01" as never, 6)).toThrow(AmountError);
    expect(() => parsePriceToAtomic("10000" as never, 6)).toThrow(AmountError);
  });

  it("throws on malformed dollar strings", () => {
    expect(() => parsePriceToAtomic("$" as never, 6)).toThrow(AmountError);
    expect(() => parsePriceToAtomic("$abc" as never, 6)).toThrow(AmountError);
    expect(() => parsePriceToAtomic("0.01$" as never, 6)).toThrow(AmountError);
  });
});

describe("exactness beyond float range", () => {
  it("handles amounts that Number cannot represent exactly", () => {
    // 2^53 + 1 = 9007199254740993 is the first integer float64 cannot represent.
    const big = "9007199254740993";
    expect(parsePriceToAtomic({ amount: big, unit: "atomic" }, 6)).toBe(9007199254740993n);
    // Prove the float path would have been wrong:
    expect(String(9007199254740993)).not.toBe(big);
  });
});

describe("sumAtomicStrings", () => {
  it("sums exact integer strings", () => {
    expect(sumAtomicStrings(["1", "2", "3"])).toBe("6");
  });

  it("sums beyond float precision exactly", () => {
    const a = "9007199254740993";
    const b = "9007199254740993";
    // Computed independently: 2 * 9007199254740993 = 18014398509481986
    expect(sumAtomicStrings([a, b])).toBe("18014398509481986");
  });

  it("throws on non-integer-string entries", () => {
    expect(() => sumAtomicStrings(["1", "2.5"])).toThrow(AmountError);
    expect(() => sumAtomicStrings(["1", ""])).toThrow(AmountError);
  });
});

describe("isAtomicString / parseAtomicString / formatAtomic", () => {
  it("validates integer strings", () => {
    expect(isAtomicString("123")).toBe(true);
    expect(isAtomicString("12.3")).toBe(false);
    expect(isAtomicString("-1")).toBe(false);
    expect(isAtomicString(123)).toBe(false);
  });

  it("round-trips bigint", () => {
    expect(formatAtomic(parseAtomicString("42"))).toBe("42");
  });
});
