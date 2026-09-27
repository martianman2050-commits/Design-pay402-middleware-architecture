// Express adapter for pay402 (x402 v2, HTTP transport).
//
// Adapter-specific hazards this file addresses (see test/express.test.ts):
// - Header casing: Node lowercases ALL incoming header names, so the
//   PAYMENT-SIGNATURE lookup uses INCOMING_HEADER_PAYMENT_SIGNATURE
//   ("payment-signature"). Outgoing headers use the canonical spec casing.
// - Await discipline: every async call in the request path is awaited.
// - Facilitator timeouts/failures map to 500 — never a silent pass-through.
// - Authorization flow ordering (spec §6.1): verify → handler → settle →
//   respond. Settlement happens by intercepting res.end BEFORE headers are
//   flushed, so PAYMENT-RESPONSE can still be attached. If the handler
//   failed (status >= 400), settle is skipped and the client is not charged.
//
// Limitation (documented in README): streaming responses (res.write before
// res.end, e.g. SSE) flush headers before settle can attach PAYMENT-RESPONSE.
// The settle still executes; only the header is omitted. JSON endpoints —
// the target use case — are fully supported.

import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  INCOMING_HEADER_PAYMENT_SIGNATURE,
  encodeHeaderJson,
} from "./encoding.js";
import { resolveConfig, type Pay402Config } from "./config.js";
import { processPayment, type CoreDecision } from "./core.js";
import { createCdpFacilitator } from "./facilitator/cdp.js";
import type { EventSink, Pay402Event } from "./events.js";
import type { FacilitatorClient } from "./types.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface PaymentWallOptions {
  /** Facilitator to use. Defaults to the Coinbase CDP hosted facilitator (lazy). */
  facilitator?: FacilitatorClient;
  /** Event sink for ledger integration. Events are fire-and-forget. */
  onEvent?: EventSink;
  /** Override the absolute resource URL advertised in challenges. */
  resourceUrl?: (req: Request) => string;
  /** MIME type advertised in ResourceInfo. Default "application/json". */
  mimeType?: string;
}

function defaultResourceUrl(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build Express middleware that puts a route behind an x402 paywall.
 * Config is validated eagerly at creation time — a bad config throws here,
 * not on the first request.
 */
export function paymentWall(config: Pay402Config, options: PaymentWallOptions = {}): RequestHandler {
  const resolved = resolveConfig(config);
  const mimeType = options.mimeType ?? "application/json";
  const getUrl = options.resourceUrl ?? defaultResourceUrl;
  const emit = options.onEvent;
  let facilitatorPromise: Promise<FacilitatorClient> | undefined;

  function getFacilitator(): FacilitatorClient | Promise<FacilitatorClient> {
    if (options.facilitator) return options.facilitator;
    facilitatorPromise ??= createCdpFacilitator();
    return facilitatorPromise;
  }

  function emitEvent(event: Pay402Event): void {
    if (emit) {
      try {
        emit(event);
      } catch {
        // Ledger failures must never take down the request path.
      }
    }
  }

  return function pay402Middleware(req: Request, res: Response, next: NextFunction): void {
    void (async () => {
      const resourceUrl = getUrl(req);
      const base = { ts: nowIso(), resourceUrl, method: req.method };

      let facilitator: FacilitatorClient;
      try {
        facilitator = await getFacilitator();
      } catch (e) {
        const error = e instanceof Error ? e.message : "facilitator unavailable";
        emitEvent({ kind: "error.occurred", ...base, error });
        res.status(500).json({ error: "pay402: facilitator unavailable", detail: error });
        return;
      }

      const raw = req.headers[INCOMING_HEADER_PAYMENT_SIGNATURE];
      const header = Array.isArray(raw) ? raw[0] : raw;

      let decision: CoreDecision;
      try {
        decision = await processPayment({
          paymentSignatureHeader: header,
          resolved,
          facilitator,
          resourceUrl,
          resourceMimeType: mimeType,
        });
      } catch (e) {
        const error = e instanceof Error ? e.message : "payment processing failed";
        emitEvent({ kind: "error.occurred", ...base, error });
        res.status(500).json({ error: "pay402: internal error", detail: error });
        return;
      }

      switch (decision.kind) {
        case "challenge": {
          emitEvent({
            kind: "challenge.issued",
            ...base,
            amount: resolved.requirements.amount,
            network: resolved.requirements.network,
            asset: resolved.requirements.asset,
          });
          res
            .status(402)
            .set(HEADER_PAYMENT_REQUIRED, encodeHeaderJson(decision.paymentRequired))
            .json({
              error: decision.paymentRequired.error ?? "payment required",
              paymentRequired: decision.paymentRequired,
            });
          return;
        }
        case "invalid": {
          emitEvent({
            kind: "payment.rejected",
            ...base,
            status: decision.status,
            error: decision.error,
            payer: decision.paymentResponse?.payer ?? null,
            amount: decision.paymentResponse ? resolved.requirements.amount : null,
            network: decision.paymentResponse ? resolved.requirements.network : null,
          });
          if (decision.paymentResponse) {
            res.set(HEADER_PAYMENT_RESPONSE, encodeHeaderJson(decision.paymentResponse));
          }
          res.status(decision.status).json({ error: decision.error });
          return;
        }
        case "error": {
          emitEvent({ kind: "error.occurred", ...base, error: decision.error });
          res.status(500).json({ error: "pay402: facilitator error", detail: decision.error });
          return;
        }
        case "verified": {
          installSettleInterceptor(req, res, next, decision, base, emitEvent, resolved.requirements.amount, resolved.requirements.network, resolved.requirements.asset);
          return;
        }
      }
    })();
  };
}

type VerifiedDecision = Extract<CoreDecision, { kind: "verified" }>;

function installSettleInterceptor(
  _req: Request,
  res: Response,
  next: NextFunction,
  decision: VerifiedDecision,
  base: { ts: string; resourceUrl: string; method: string },
  emitEvent: (e: Pay402Event) => void,
  amount: string,
  network: string,
  asset: string,
): void {
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response;
  let intercepting = true;

  // res.end is intercepted exactly once. All paths below either finish with
  // settleThenEnd (which replays or replaces the buffered response) or pass
  // straight through when headers are already on the wire (streaming).
  res.end = ((...args: unknown[]) => {
    if (!intercepting || res.headersSent) {
      // Streaming case: headers already flushed. Settle for the money's sake,
      // but we cannot attach PAYMENT-RESPONSE anymore.
      if (intercepting && res.statusCode < 400) {
        void settleStreamingFallback(decision, base, emitEvent, network);
      }
      intercepting = false;
      return originalEnd(...args);
    }
    intercepting = false;
    void settleThenEnd(res, originalEnd, args, decision, base, emitEvent, amount, network, asset);
    return res;
  }) as Response["end"];

  next();
}

async function settleStreamingFallback(
  decision: VerifiedDecision,
  base: { ts: string; resourceUrl: string; method: string },
  emitEvent: (e: Pay402Event) => void,
  network: string,
): Promise<void> {
  try {
    const outcome = await decision.settle();
    if (outcome.success) {
      emitEvent({
        kind: "payment.settled",
        ...base,
        payer: outcome.response.payer ?? decision.payer ?? null,
        amount: outcome.response.amount ?? "0",
        network: outcome.response.network ?? network,
        asset: "",
        transaction: outcome.response.transaction,
      });
    }
  } catch {
    emitEvent({ kind: "error.occurred", ...base, error: "settle failed after streaming response" });
  }
}

async function settleThenEnd(
  res: Response,
  originalEnd: (...args: unknown[]) => Response,
  endArgs: unknown[],
  decision: VerifiedDecision,
  base: { ts: string; resourceUrl: string; method: string },
  emitEvent: (e: Pay402Event) => void,
  amount: string,
  network: string,
  asset: string,
): Promise<void> {
  // Handler failed → do NOT settle; the client is not charged for a failed
  // resource (scheme_exact.md "Payment Flow": authorization commits only
  // after the handler succeeds).
  if (res.statusCode >= 400) {
    emitEvent({
      kind: "settlement.skipped",
      ...base,
      payer: decision.payer ?? null,
      amount,
      network,
      reason: "handler_failed",
      statusCode: res.statusCode,
    });
    originalEnd(...endArgs);
    return;
  }

  try {
    const outcome = await decision.settle();
    if (outcome.success) {
      emitEvent({
        kind: "payment.settled",
        ...base,
        payer: outcome.response.payer ?? decision.payer ?? null,
        amount: outcome.response.amount ?? amount,
        network: outcome.response.network ?? network,
        asset,
        transaction: outcome.response.transaction,
      });
      res.set(HEADER_PAYMENT_RESPONSE, encodeHeaderJson(outcome.response));
      originalEnd(...endArgs);
      return;
    }

    // Settle rejected: replace the buffered success body with a spec-shaped
    // 402 + PAYMENT-RESPONSE (transports-v2/http.md "Error Handling":
    // Payment Failed → 402). Headers have not been flushed yet, so status,
    // headers, and body are all still ours to set.
    emitEvent({
      kind: "payment.rejected",
      ...base,
      status: 402,
      error: outcome.error,
      payer: outcome.response.payer ?? decision.payer ?? null,
      amount,
      network,
    });
    res.set(HEADER_PAYMENT_RESPONSE, encodeHeaderJson(outcome.response));
    replaceBody(res, originalEnd, 402, { error: outcome.error });
  } catch (e) {
    // Facilitator unreachable/timed out during settle: outcome is
    // indeterminate (spec §9 settlement_pending semantics). Respond 500;
    // do NOT pretend the resource was delivered for free, do NOT charge.
    const error = e instanceof Error ? e.message : "settle failed";
    emitEvent({ kind: "error.occurred", ...base, error });
    replaceBody(res, originalEnd, 500, { error: "pay402: settlement failed", detail: error });
  }
}

/**
 * Replace the buffered response body. Content-Length must be recomputed via
 * Buffer.byteLength (byte-exact; never string length, never Number math).
 */
function replaceBody(
  res: Response,
  originalEnd: (...args: unknown[]) => Response,
  status: number,
  body: unknown,
): void {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.status(status);
  res.removeHeader("Content-Length");
  res.set("Content-Type", "application/json; charset=utf-8");
  res.set("Content-Length", String(buf.byteLength));
  originalEnd(buf);
}
