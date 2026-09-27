// Wire types for x402 protocol v2.
// Source: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
// Cross-checked against @x402/core 2.27.0 type defs (node_modules/@x402/core/dist/cjs/x402Client-C7_OogbK.d.ts).
// All amounts are integer strings in atomic token units — never numbers.

export const X402_VERSION = 2 as const;

/** CAIP-2 network identifier, e.g. "eip155:84532" (spec §11.1). */
export type Network = string;

/** ResourceInfo — spec §5.1.2. */
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

/** PaymentRequirements — spec §5.1.2. `amount` is an atomic-unit integer string. */
export interface PaymentRequirements {
  scheme: string;
  network: Network;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** PaymentRequired — spec §5.1. Carried base64-encoded in the PAYMENT-REQUIRED header. */
export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** EIP-3009 authorization — spec §5.2.2 / scheme_exact_evm.md §1. */
export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** exact/EVM eip3009 payload — scheme_exact_evm.md §1 Phase 1. */
export interface ExactEvmPayload {
  signature: string;
  authorization: Eip3009Authorization;
}

/** PaymentPayload — spec §5.2. Carried base64-encoded in the PAYMENT-SIGNATURE header. */
export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** VerifyResponse — spec §5.4. */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  extensions?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/** SettleResponse — spec §5.3. */
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: Network;
  amount?: string;
  extensions?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/** SupportedKind / SupportedResponse — spec §7.3. */
export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: Network;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
}

/**
 * Facilitator client — spec §7. Positional signatures are deliberately
 * identical to `HTTPFacilitatorClient` from @x402/core/server so that
 * createCdpFacilitatorClient() is structurally assignable.
 */
export interface FacilitatorClient {
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse>;
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse>;
}
