// Adapter for the Coinbase CDP hosted facilitator (non-custodial: CDP holds no
// payer funds; we hold no private keys — the facilitator only verifies/settles).
//
// Verified facts (2026-09-27):
// - CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402"
//   (node_modules/@coinbase/cdp-sdk/_types/x402/facilitator.d.ts, and
//    https://docs.cdp.coinbase.com/sdks/cdp-sdks-v2/typescript/x402/variables/CDP_FACILITATOR_URL.md)
// - createCdpFacilitatorClient({ apiKeyId?, apiKeySecret?, baseUrl? }) returns
//   HTTPFacilitatorClient implementing verify(paymentPayload, paymentRequirements)
//   and settle(paymentPayload, paymentRequirements) — structurally identical to
//   our FacilitatorClient interface.
// - Credentials resolve: explicit args → CDP_API_KEY_ID / CDP_API_KEY_SECRET env
//   vars; auth is JWT-based (no raw key headers on our side).
//
// The SDK is loaded LAZILY (dynamic import) so the zero-dependency core never
// pulls it in unless a CDP facilitator is actually configured.

import type { FacilitatorClient } from "../types.js";

export interface CdpFacilitatorConfig {
  apiKeyId?: string;
  apiKeySecret?: string;
  /** Override base URL (staging/canary). Defaults to the CDP production endpoint. */
  baseUrl?: string;
}

let cached: Promise<FacilitatorClient> | undefined;

/**
 * Create (or reuse) a CDP hosted facilitator client.
 * Requires @coinbase/cdp-sdk to be installed and CDP_API_KEY_ID /
 * CDP_API_KEY_SECRET to be available (env or explicit args).
 */
export function createCdpFacilitator(
  config: CdpFacilitatorConfig = {},
): Promise<FacilitatorClient> {
  cached ??= (async () => {
    let mod: {
      createCdpFacilitatorClient: (args?: CdpFacilitatorConfig) => FacilitatorClient;
    };
    try {
      mod = (await import("@coinbase/cdp-sdk/x402")) as unknown as typeof mod;
    } catch (e) {
      throw new Error(
        "pay402: the CDP facilitator requires the optional dependency @coinbase/cdp-sdk " +
          "(npm install @coinbase/cdp-sdk). Note: its ./x402 subpath also needs @x402/core installed.",
        { cause: e },
      );
    }
    return mod.createCdpFacilitatorClient(config);
  })();
  return cached;
}

/** Test/dev helper: drop the cached client so the next call re-imports. */
export function resetCdpFacilitatorCache(): void {
  cached = undefined;
}
