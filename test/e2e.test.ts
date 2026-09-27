// End-to-end: REAL official x402 client (examples/agent-demo) ↔ REAL HTTP ↔
// pay402 Express server (examples/server-llm), with the offline
// MockFacilitator standing in for the Coinbase CDP hosted facilitator.
//
// Hermetic: per-test temp ledger dir (mkdtemp/rm), per-test generated
// signer, ephemeral port, no top-level shared state.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createLlmServer, DEFAULT_LLM_CONFIG, type LlmServer } from "../examples/server-llm/app.js";
import { runAgent } from "../examples/agent-demo/agent.js";
import { MockFacilitator } from "../src/facilitator/mock.js";
import { computeStats } from "../src/dashboard.js";
import { decodeHeaderJson, HEADER_PAYMENT_REQUIRED } from "../src/encoding.js";
import type { LedgerRecord } from "../src/ledger.js";
import type { PaymentRequired } from "../src/types.js";

// $0.01 at USDC's 6 decimals = 10000 atomic units (exact integer string;
// derivation covered by test/amount.test.ts parsePriceToAtomic cases).
const PRICE_ATOMIC = "10000";

describe("e2e: agent pays mock-LLM server over real HTTP", () => {
  let dir: string | undefined;
  let server: Server | undefined;
  let llm: LlmServer | undefined;
  let facilitator: MockFacilitator | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pay402-e2e-"));
  });

  afterEach(async () => {
    if (server) {
      // Close idle keep-alive sockets first (undici/fetch pools them),
      // otherwise close() waits for them.
      server.closeIdleConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (llm) {
      // Drain fire-and-forget ledger appends BEFORE deleting the temp dir —
      // every event is emitted before its HTTP response completes, so after
      // the server is closed the queue is complete. Skipping this races
      // rm(dir) against appendNow's open() → ENOENT unhandled rejections.
      await llm.ledger.flush().catch(() => undefined);
      llm = undefined;
    }
    facilitator = undefined;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function startServer(fac: MockFacilitator): Promise<void> {
    facilitator = fac;
    llm = createLlmServer({
      facilitator: fac,
      ledgerPath: join(dir!, "ledger.jsonl"),
      config: DEFAULT_LLM_CONFIG,
    });
    server = llm.app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  it("unpaid plain fetch gets 402 with a decodable PAYMENT-REQUIRED challenge", async () => {
    await startServer(new MockFacilitator());
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(402);
    const header = res.headers.get(HEADER_PAYMENT_REQUIRED);
    expect(header).toBeTruthy();
    const decoded = decodeHeaderJson<PaymentRequired>(header!, HEADER_PAYMENT_REQUIRED);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0]?.amount).toBe(PRICE_ATOMIC);
    expect(decoded.accepts[0]?.network).toBe("eip155:84532");
    expect(decoded.accepts[0]?.scheme).toBe("exact");
  });

  it("agent pays end-to-end: 200, genuine eip3009 signature, exact ledger + dashboard", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    // The mock reports the actual signer as payer (a real facilitator
    // derives it from the payload). The assertion on authorization.from
    // below still proves the genuine signature came from the agent's key.
    await startServer(new MockFacilitator({ payer: account.address }));

    const result = await runAgent({ baseUrl, privateKey, prompt: "pay402 e2e" });

    expect(result.status).toBe(200);
    const body = result.body as { choices?: Array<{ message?: { content?: string } }> };
    expect(body.choices?.[0]?.message?.content).toBe("You said: pay402 e2e");

    // The agent really signed an eip3009 authorization with its own key.
    expect(facilitator!.verifyCalls).toHaveLength(1);
    const payload = facilitator!.verifyCalls[0]!.paymentPayload;
    expect(payload.x402Version).toBe(2);
    const authorization = payload.payload as { authorization?: { from?: string; value?: string } };
    expect(authorization.authorization?.from?.toLowerCase()).toBe(account.address.toLowerCase());
    expect(authorization.authorization?.value).toBe(PRICE_ATOMIC);

    await llm!.ledger.flush();
    const records: LedgerRecord[] = await llm!.ledger.read();
    const settled = records.find((r) => r.kind === "payment.settled");
    expect(settled).toBeDefined();
    expect(settled?.kind === "payment.settled" ? settled.payer : undefined).toBe(account.address);

    const stats = computeStats(records);
    expect(stats.settledCount).toBe(1);
    expect(stats.totalSettledAtomic).toBe(PRICE_ATOMIC);
    expect(stats.uniquePayerCount).toBe(1);
    // The agent's first (unpaid) attempt issued a challenge; it must be
    // counted but NEVER attributed to a payer (payerless contract).
    expect(stats.challenges).toBeGreaterThanOrEqual(1);

    const dashRes = await fetch(`${baseUrl}/dashboard`);
    expect(dashRes.status).toBe(200);
    const dash = (await dashRes.json()) as {
      totalSettledAtomic?: string;
      totalSettledUsdc?: string;
      settledCount?: number;
      uniquePayerCount?: number;
    };
    expect(dash.totalSettledAtomic).toBe(PRICE_ATOMIC);
    expect(dash.totalSettledUsdc).toBe("0.010000");
    expect(dash.settledCount).toBe(1);
    expect(dash.uniquePayerCount).toBe(1);
  });

  it("unpaid malformed body still gets the 402 challenge (paywall runs before the handler)", async () => {
    await startServer(new MockFacilitator());
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(402);
    expect(facilitator!.settleCalls).toHaveLength(0);
    expect(facilitator!.verifyCalls).toHaveLength(0);
  });

  it("settle rejection reaches the agent as 402 (no silent free pass)", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    await startServer(
      new MockFacilitator({ payer: account.address, rejectSettle: "insufficient_funds" }),
    );

    // Observed behavior (debug/reject-probe.ts, @x402/fetch 2.27.0): the
    // official client RETURNS the server's 402 + error body; it does not
    // throw and does not retry after a settle rejection.
    const result = await runAgent({ baseUrl, privateKey });
    expect(result.status).toBe(402);
    expect(result.body).toEqual({ error: "insufficient_funds" });
    expect(facilitator!.verifyCalls).toHaveLength(1);
    expect(facilitator!.settleCalls).toHaveLength(1);

    // Nothing was recorded as settled revenue; the rejection IS recorded.
    await llm!.ledger.flush();
    const records = await llm!.ledger.read();
    const stats = computeStats(records);
    expect(stats.settledCount).toBe(0);
    expect(stats.totalSettledAtomic).toBe("0");
    expect(stats.rejectedCount).toBe(1);
    expect(stats.uniquePayerCount).toBe(0); // rejected payments are never attributed per-payer
  });
});
