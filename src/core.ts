// Framework-agnostic payment processing for x402 v2, HTTP transport.
//
// Flow implemented: the spec's default `authorization` payment flow —
// verify → resource → settle → respond (x402-specification-v2.md §6.1;
// scheme_exact.md "Payment Flow"). The core deliberately does NOT run the
// resource handler itself: it returns a `verified` decision carrying a settle()
// closure, so any adapter controls handler execution between verify and settle.
//
// Security property: verification and settlement always use the SERVER-BUILT
// PaymentRequirements (from resolveConfig), never the client-echoed `accepted`
// object — a client cannot downgrade amount/asset/payTo by tampering with its
// payload copy. The client's `accepted` is only checked for consistency and a
// mismatch is rejected as invalid.

import { HeaderDecodeError, decodeHeaderJson } from "./encoding.js";
import { X402_VERSION } from "./types.js";
import type {
  FacilitatorClient,
  PaymentPayload,
  PaymentRequirements,
  PaymentRequired,
  ResourceInfo,
  SettleResponse,
  VerifyResponse,
} from "./types.js";
import type { ResolvedConfig } from "./config.js";

export class FacilitatorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FacilitatorError";
  }
}

export class PaymentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentProtocolError";
  }
}

export type CoreDecision =
  /** No (or empty) PAYMENT-SIGNATURE header → respond 402 + PAYMENT-REQUIRED. */
  | { kind: "challenge"; paymentRequired: PaymentRequired }
  /** Malformed payload (→400) or verify/settle rejection (→402 + PAYMENT-RESPONSE). */
  | { kind: "invalid"; status: 400 | 402; error: string; paymentResponse?: SettleResponse }
  /** Facilitator unreachable/timed out → 500. Never silently pass a request. */
  | { kind: "error"; status: 500; error: string }
  /** Verify succeeded. Adapter runs the handler, then MUST call settle(). */
  | {
      kind: "verified";
      paymentPayload: PaymentPayload;
      payer: string | undefined;
      verifyResponse: VerifyResponse;
      settle: () => Promise<SettleOutcome>;
    };

export type SettleOutcome =
  | { success: true; response: SettleResponse }
  | { success: false; response: SettleResponse; error: string };

export interface ProcessPaymentInput {
  /** Raw PAYMENT-SIGNATURE header value (adapters must look it up case-insensitively). */
  paymentSignatureHeader: string | undefined;
  resolved: ResolvedConfig;
  facilitator: FacilitatorClient;
  /** Absolute URL of the protected resource (spec §5.1.2 ResourceInfo.url). */
  resourceUrl: string;
  resourceMimeType?: string;
}

function buildResourceInfo(input: ProcessPaymentInput): ResourceInfo {
  return {
    url: input.resourceUrl,
    ...(input.resolved.description !== undefined ? { description: input.resolved.description } : {}),
    ...(input.resourceMimeType !== undefined ? { mimeType: input.resourceMimeType } : {}),
    ...(input.resolved.serviceName !== undefined ? { serviceName: input.resolved.serviceName } : {}),
  };
}

export function buildPaymentRequired(
  resolved: ResolvedConfig,
  resource: ResourceInfo,
  error?: string,
): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    ...(error !== undefined ? { error } : {}),
    resource,
    accepts: [resolved.requirements],
  };
}

async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new FacilitatorError(`facilitator ${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requirementsMatch(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.amount === b.amount &&
    a.asset.toLowerCase() === b.asset.toLowerCase() &&
    a.payTo.toLowerCase() === b.payTo.toLowerCase()
  );
}

/**
 * Phase 1 of the authorization flow: parse the payment header (if any) and
 * verify it with the facilitator. On `verified`, run the resource handler,
 * then call the returned settle() (phase 2).
 */
export async function processPayment(input: ProcessPaymentInput): Promise<CoreDecision> {
  const { paymentSignatureHeader, resolved, facilitator } = input;
  const resource = buildResourceInfo(input);

  if (paymentSignatureHeader === undefined || paymentSignatureHeader.trim() === "") {
    return {
      kind: "challenge",
      paymentRequired: buildPaymentRequired(
        resolved,
        resource,
        "PAYMENT-SIGNATURE header is required",
      ),
    };
  }

  let payload: PaymentPayload;
  try {
    payload = decodeHeaderJson<PaymentPayload>(
      paymentSignatureHeader,
      "PAYMENT-SIGNATURE",
    );
  } catch (e) {
    const msg = e instanceof HeaderDecodeError ? e.message : "malformed PAYMENT-SIGNATURE header";
    return { kind: "invalid", status: 400, error: msg };
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    payload.x402Version !== X402_VERSION ||
    typeof payload.accepted !== "object" ||
    payload.accepted === null ||
    typeof payload.payload !== "object" ||
    payload.payload === null
  ) {
    return {
      kind: "invalid",
      status: 400,
      error: `invalid payment payload: expected x402Version ${X402_VERSION} with accepted and payload objects`,
    };
  }

  if (!requirementsMatch(payload.accepted, resolved.requirements)) {
    return {
      kind: "invalid",
      status: 400,
      error: "payment payload accepted-requirements do not match the server's payment requirements",
    };
  }

  const serverRequirements = resolved.requirements;

  let verifyResponse: VerifyResponse;
  try {
    verifyResponse = await withTimeout("verify", resolved.facilitatorTimeoutMs, () =>
      facilitator.verify(payload, serverRequirements),
    );
  } catch (e) {
    return {
      kind: "error",
      status: 500,
      error: e instanceof Error ? e.message : "facilitator verify failed",
    };
  }

  if (!verifyResponse.isValid) {
    return {
      kind: "invalid",
      status: 402,
      error: verifyResponse.invalidReason ?? verifyResponse.invalidMessage ?? "payment verification failed",
      paymentResponse: {
        success: false,
        errorReason: verifyResponse.invalidReason ?? "invalid_payload",
        ...(verifyResponse.payer !== undefined ? { payer: verifyResponse.payer } : {}),
        transaction: "",
        network: serverRequirements.network,
      },
    };
  }

  return {
    kind: "verified",
    paymentPayload: payload,
    payer: verifyResponse.payer,
    verifyResponse,
    settle: async (): Promise<SettleOutcome> => {
      let settleResponse: SettleResponse;
      try {
        settleResponse = await withTimeout("settle", resolved.facilitatorTimeoutMs, () =>
          facilitator.settle(payload, serverRequirements),
        );
      } catch (e) {
        throw new FacilitatorError(
          e instanceof Error ? e.message : "facilitator settle failed",
          { cause: e },
        );
      }
      if (settleResponse.success) {
        return { success: true, response: settleResponse };
      }
      return {
        success: false,
        response: settleResponse,
        error: settleResponse.errorReason ?? settleResponse.errorMessage ?? "settlement failed",
      };
    },
  };
}
