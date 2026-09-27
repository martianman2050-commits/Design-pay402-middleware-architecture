// Pure test helpers. No top-level side effects, no shared mutable state —
// importing this module cannot create order-dependent test results.

import { encodeHeaderJson } from "../src/encoding.js";
import { resolveConfig, type Pay402Config } from "../src/config.js";
import type { ExactEvmPayload, PaymentPayload } from "../src/types.js";

export const TEST_PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
export const TEST_PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
export const TEST_RESOURCE_URL = "https://api.example.com/v1/chat/completions";

export function baseConfig(overrides: Partial<Pay402Config> = {}): Pay402Config {
  return {
    price: "$0.01",
    network: "eip155:84532",
    payTo: TEST_PAY_TO,
    ...overrides,
  };
}

/** Build a spec-shaped exact/EVM eip3009 PaymentPayload matching the server requirements. */
export function buildPaymentPayload(config: Pay402Config = baseConfig()): PaymentPayload {
  const resolved = resolveConfig(config);
  const payload: ExactEvmPayload = {
    signature: "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a128325976417",
    authorization: {
      from: TEST_PAYER,
      to: resolved.requirements.payTo,
      value: resolved.requirements.amount,
      validAfter: "1740672089",
      validBefore: "1740672154",
      nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
    },
  };
  return {
    x402Version: 2,
    resource: { url: TEST_RESOURCE_URL },
    accepted: resolved.requirements,
    payload: payload as unknown as Record<string, unknown>,
  };
}

/** Base64-encode a PaymentPayload into a PAYMENT-SIGNATURE header value. */
export function paymentSignatureHeader(config: Pay402Config = baseConfig()): string {
  return encodeHeaderJson(buildPaymentPayload(config));
}
