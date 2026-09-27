// Base64 ⇄ JSON encoding for the three HTTP transport headers.
// Source: specs/transports-v2/http.md "Header Summary":
//   PAYMENT-REQUIRED  (server → client, base64 PaymentRequired, on HTTP 402)
//   PAYMENT-SIGNATURE (client → server, base64 PaymentPayload)
//   PAYMENT-RESPONSE  (server → client, base64 SettlementResponse)
// NOTE: these replaced v1's X-PAYMENT / x-payment-response headers.

/** Canonical spec casing — use when setting outgoing headers. */
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

/**
 * Lowercased names — use when reading incoming headers.
 * Node's http (and therefore Express) lowercases all incoming header names,
 * so req.headers["PAYMENT-SIGNATURE"] would silently never match.
 */
export const INCOMING_HEADER_PAYMENT_SIGNATURE = HEADER_PAYMENT_SIGNATURE.toLowerCase();
export const INCOMING_HEADER_PAYMENT_REQUIRED = HEADER_PAYMENT_REQUIRED.toLowerCase();

export class HeaderDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HeaderDecodeError";
  }
}

export function encodeHeaderJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeaderJson<T>(headerValue: string, headerName: string): T {
  let json: string;
  try {
    json = Buffer.from(headerValue, "base64").toString("utf8");
  } catch (e) {
    throw new HeaderDecodeError(`${headerName} header is not valid base64`, { cause: e });
  }
  try {
    return JSON.parse(json) as T;
  } catch (e) {
    throw new HeaderDecodeError(`${headerName} header does not contain valid JSON`, { cause: e });
  }
}
