// Payment event contract shared by adapters (producers) and the ledger
// (consumer). Discriminated by `kind`.
//
// EXPLICIT CONTRACT (tested in test/ledger.test.ts and test/dashboard.test.ts):
// - `challenge.issued` and `error.occurred` are PAYERLESS by construction —
//   their types have no payer field. They must never be aggregated into
//   per-payer or unique-payer counts.
// - `payment.rejected` carries `payer: string | null` — null when the payer
//   could not be determined (malformed payload). Only non-null payers may
//   enter per-payer aggregation.
// - `payment.settled` and `settlement.skipped` always carry a payer when one
//   was established by verify (`payer: string | null` — null only if the
//   facilitator's verify response omitted it).

/** Common fields on every event. */
export interface EventBase {
  /** ISO-8601 timestamp, assigned by the emitter. */
  ts: string;
  /** Absolute URL of the protected resource. */
  resourceUrl: string;
  /** HTTP method of the request. */
  method: string;
}

/** 402 challenge emitted for an unpaid request. PAYERLESS — no payer field. */
export interface ChallengeIssuedEvent extends EventBase {
  kind: "challenge.issued";
  amount: string;
  network: string;
  asset: string;
}

/** A payment was presented but rejected (malformed 400, verify/settle failure 402). */
export interface PaymentRejectedEvent extends EventBase {
  kind: "payment.rejected";
  status: 400 | 402;
  error: string;
  /** Payer address if it could be determined; null otherwise. */
  payer: string | null;
  amount: string | null;
  network: string | null;
}

/** Payment verified AND settled successfully. */
export interface PaymentSettledEvent extends EventBase {
  kind: "payment.settled";
  payer: string | null;
  amount: string;
  network: string;
  asset: string;
  transaction: string;
}

/**
 * Verify succeeded but the resource handler failed, so settlement was
 * intentionally skipped (authorization flow: a failed handler leaves the
 * client uncharged — scheme_exact.md "Payment Flow").
 */
export interface SettlementSkippedEvent extends EventBase {
  kind: "settlement.skipped";
  payer: string | null;
  amount: string;
  network: string;
  reason: "handler_failed";
  statusCode: number;
}

/** Infrastructure failure (facilitator timeout/unreachable). PAYERLESS. */
export interface ErrorOccurredEvent extends EventBase {
  kind: "error.occurred";
  error: string;
}

export type Pay402Event =
  | ChallengeIssuedEvent
  | PaymentRejectedEvent
  | PaymentSettledEvent
  | SettlementSkippedEvent
  | ErrorOccurredEvent;

/** Event sink — the ledger implements this; adapters only fire-and-forget. */
export interface EventSink {
  (event: Pay402Event): void;
}

/** Events that can never carry a payer. Kept as a runtime-checkable list. */
export const PAYERLESS_EVENT_KINDS = ["challenge.issued", "error.occurred"] as const;

/** Type guard: does this event carry a payer field that may be non-null? */
export function eventMayHavePayer(e: Pay402Event): e is
  | PaymentRejectedEvent
  | PaymentSettledEvent
  | SettlementSkippedEvent {
  return (
    e.kind === "payment.rejected" ||
    e.kind === "payment.settled" ||
    e.kind === "settlement.skipped"
  );
}
