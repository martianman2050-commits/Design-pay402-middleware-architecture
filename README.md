# pay402

Drop-in [x402](https://github.com/x402-foundation/x402) payment middleware for
APIs. Charge AI agents per request in stablecoins (USDC) — **without ever
custodying funds**: a hosted facilitator verifies and settles each payment
straight to your wallet. pay402 never sees a private key.

Built against **x402 protocol v2** (spec v2.0, 2025-12-09): `x402Version: 2`,
CAIP-2 network ids (`eip155:84532`), and the v2 headers `PAYMENT-REQUIRED` /
`PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` (v1's `X-PAYMENT` is NOT supported).

## How it works (authorization flow, spec §6.1)

```
agent → GET /resource                     (no payment header)
      ← 402 + PAYMENT-REQUIRED            (base64 PaymentRequired challenge)
agent signs EIP-3009 authorization locally (key never leaves the agent)
agent → GET /resource + PAYMENT-SIGNATURE
      server: facilitator.verify → YOUR HANDLER → facilitator.settle
      ← 200 + PAYMENT-RESPONSE            (base64 SettlementResponse)
```

- **Handler fails (status ≥ 400)?** Settlement is skipped — the agent is not
  charged for a resource you didn't deliver.
- **Facilitator unreachable/times out?** 500 — never a silent free pass.
- **Client tampers with the accepted requirements?** The server verifies and
  settles against its OWN server-built requirements (amount/asset/payTo cannot
  be swapped); a mismatch is a 400.

## Install

```sh
npm install pay402 express
# hosted facilitator (default):
npm install @coinbase/cdp-sdk
```

Requires Node ≥ 20. TypeScript-first; framework-agnostic core (`pay402`),
Express adapter (`pay402/express`), ledger (`pay402/ledger`), read-only
dashboard (`pay402/dashboard`), offline mock (`pay402/mock-facilitator`).

## Quickstart (Express)

```ts
import express from "express";
import { paymentWall } from "pay402/express";
import { createLedger } from "pay402/ledger";

const ledger = createLedger("./ledger.jsonl");

const app = express();
app.post(
  "/v1/chat/completions",
  paymentWall(
    {
      price: "$0.01",                    // or { amount: "10000", unit: "atomic" }
      network: "eip155:84532",           // Base Sepolia (testnet)
      payTo: "0xYourWalletAddress",      // settles directly to you
    },
    { onEvent: (e) => ledger.append(e) }, // optional append-only audit trail
  ),
  async (req, res) => {
    res.json({ choices: [/* ... */] });   // handler failure ⇒ no charge
  },
);
```

Facilitator credentials come from the environment:
`CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`
([Coinbase CDP portal](https://portal.cdp.coinbase.com/)).

### Defaults and why

- **Default facilitator: Coinbase CDP hosted facilitator**
  (`https://api.cdp.coinbase.com/platform/v2/x402`, verified against
  `@coinbase/cdp-sdk`'s own `CDP_FACILITATOR_URL` constant). Chosen because
  the core constraint of pay402 is *no custody*: a hosted facilitator verifies
  EIP-3009 signatures and settles on-chain directly to your `payTo`, so this
  package never touches keys or funds. It is loaded lazily and only when you
  don't inject your own `facilitator`.
- **Example/test default network: `eip155:84532` (Base Sepolia testnet)** —
  safe to demo with zero funds at stake. Mainnet `eip155:8453` (Base) is
  equally supported; both USDC addresses are pinned from
  [Circle's official contract-address docs](https://developers.circle.com/stablecoins/usdc-contract-addresses)
  (see `src/config.ts` for the citation and the exact addresses).
- **Scheme: `exact` with EIP-3009 transfer** (the spec's default
  `assetTransferMethod`), USDC only, 6 decimals.

## Money-handling guarantees

- Every amount is a **BigInt / atomic-unit integer string end-to-end** —
  including the dashboard. `Number()`/`parseFloat()`/`parseInt()` are banned
  in `src/` and `test/` by ESLint (guard proven by test), and the dashboard
  sum is asserted exact at float-breaking size against an independently
  computed BigInt sum.
- **No silent unit inference**: a price is `"$0.01"` or
  `{ amount: "10000", unit: "atomic" }` — a bare number or ambiguous string
  throws at config time.
- Wire network ids are canonical **CAIP-2 only**; human aliases
  (`base-sepolia`) never appear in protocol payloads.

## Ledger & dashboard

- `Ledger` is an append-only JSONL log with a SHA-256 **hash chain** and a
  **per-record content hash** (any field edit, deletion, or reorder fails
  `read()` with `LedgerCorruptionError`), fsync'd per append, safe under
  concurrency (serialized write queue).
- **Payerless-event contract**: `challenge.issued` and `error.occurred` carry
  NO payer field at all; `payment.rejected` may carry `payer: null`. The
  dashboard never aggregates these into per-payer/unique-payer stats — only
  successfully settled payments with a non-null payer count as revenue.
  Enforced by test at the raw-JSON-line level.
- The dashboard module is **read-only** and serializes a fixed whitelist of
  aggregate fields — no write path, no secrets (facilitator credentials never
  enter ledger records by construction).

## Examples — a paying agent end-to-end

```sh
npm run example:server   # metered mock-LLM API (offline MockFacilitator)
npm run example:agent    # official x402 client stack pays one request
curl http://127.0.0.1:4021/dashboard
```

See [`examples/README.md`](examples/README.md) for the real-CDP/testnet run
and honest caveats (e.g. the mock reports a static payer; the e2e test asserts
the genuine EIP-3009 signer).

## Testing

```sh
npm run typecheck && npm run lint && npm test
```

82 tests: unit (amount/config/core/encoding/ledger/dashboard), real-HTTP
adapter tests (supertest), an end-to-end agent↔server test using the official
`@x402/*` 2.27.0 client stack over real HTTP, and a package-surface test that
imports the public API through a real Node ESM loader (tsx child process).
The suite is hermetic (per-test temp dirs, no top-level shared state) and
passes under `--sequence.shuffle` with multiple seeds.

## Limitations

- **Streaming responses** (SSE / `res.write` before `res.end`): settlement
  still executes, but `PAYMENT-RESPONSE` cannot be attached once headers are
  flushed. JSON endpoints — the target use case — are fully supported.
- Only the `exact` scheme with `eip3009` asset transfer on Base / Base
  Sepolia is supported today (the registry in `src/config.ts` is the single
  source of truth).

## Porting the adapter to Python/FastAPI

The core (`processPayment`), wire types, ledger format, and dashboard math
are framework-agnostic and port directly. Adapter-level differences:

- **Settle placement is simpler**: ASGI builds the full response object before
  anything goes on the wire, so `settle` + `PAYMENT-RESPONSE` attachment
  happens naturally before returning the response — no `res.end` interception
  like the Express adapter needs.
- **Header casing is a non-issue**: Starlette's `request.headers` is
  case-insensitive; emit canonical-cased response headers per spec.
- **No BigInt hazard**: Python ints are arbitrary precision, but keep amounts
  as integer *strings* on the wire (JSON has no safe 64-bit number type) and
  never round-trip through `float`.
- Use `httpx.AsyncClient` for facilitator calls with the same timeout→500
  semantics; `base64`/`hashlib`/JSONL map 1:1.

## License

MIT
