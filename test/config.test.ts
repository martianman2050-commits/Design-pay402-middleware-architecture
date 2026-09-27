import { describe, expect, it } from "vitest";
import { ConfigError, NETWORKS, resolveConfig } from "../src/config.js";
import { baseConfig, TEST_PAY_TO } from "./helpers.js";

describe("NETWORKS registry — verified constants (Circle docs, spec §11.1)", () => {
  it("pins Base Sepolia USDC to the Circle-documented address", () => {
    expect(NETWORKS["eip155:84532"].usdc).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  it("pins Base mainnet USDC to the Circle-documented address", () => {
    expect(NETWORKS["eip155:8453"].usdc).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("keeps human aliases strictly separate from CAIP-2 wire ids", () => {
    for (const info of Object.values(NETWORKS)) {
      expect(info.caip2).toMatch(/^eip155:\d+$/);
      expect(info.alias).not.toBe(info.caip2);
      expect(info.caip2).not.toContain("base");
    }
  });
});

describe("resolveConfig", () => {
  it("resolves $0.01 on Base Sepolia to exact spec-shaped requirements", () => {
    const r = resolveConfig(baseConfig());
    expect(r.requirements).toEqual({
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000", // $0.01 at 6 decimals — matches spec §5.1.1 example amount
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: TEST_PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
    });
    expect(r.priceAtomic).toBe(10000n);
  });

  it("resolves mainnet network to mainnet USDC asset", () => {
    const r = resolveConfig(baseConfig({ network: "eip155:8453" }));
    expect(r.requirements.network).toBe("eip155:8453");
    expect(r.requirements.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("accepts explicit atomic pricing", () => {
    const r = resolveConfig(baseConfig({ price: { amount: "250000", unit: "atomic" } }));
    expect(r.requirements.amount).toBe("250000");
  });

  it("throws on an unknown/legacy network identifier", () => {
    expect(() => resolveConfig(baseConfig({ network: "base-sepolia" as never }))).toThrow(ConfigError);
    expect(() => resolveConfig(baseConfig({ network: "84532" as never }))).toThrow(ConfigError);
  });

  it("throws on bare-number price (no silent unit inference)", () => {
    expect(() => resolveConfig(baseConfig({ price: 0.01 as never }))).toThrow(ConfigError);
  });

  it("throws on invalid payTo", () => {
    expect(() => resolveConfig(baseConfig({ payTo: "merchant" }))).toThrow(ConfigError);
    expect(() => resolveConfig(baseConfig({ payTo: "0x123" }))).toThrow(ConfigError);
  });

  it("throws on invalid maxTimeoutSeconds", () => {
    expect(() => resolveConfig(baseConfig({ maxTimeoutSeconds: 0 }))).toThrow(ConfigError);
    expect(() => resolveConfig(baseConfig({ maxTimeoutSeconds: 1.5 }))).toThrow(ConfigError);
  });

  it("throws on over-length serviceName (spec §5.1.2: max 32)", () => {
    expect(() => resolveConfig(baseConfig({ serviceName: "x".repeat(33) }))).toThrow(ConfigError);
  });
});
