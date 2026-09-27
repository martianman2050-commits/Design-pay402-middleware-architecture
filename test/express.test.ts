// Real HTTP round-trip tests via supertest — NOT direct middleware calls with
// hand-built req/res. Every test builds a fresh express app and a fresh
// MockFacilitator inside the test body: no top-level shared state, so results
// cannot depend on file/test ordering.

import { describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { paymentWall } from "../src/express.js";
import { MockFacilitator } from "../src/facilitator/mock.js";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  decodeHeaderJson,
} from "../src/encoding.js";
import type { PaymentRequired, SettleResponse } from "../src/types.js";
import type { Pay402Event } from "../src/events.js";
import type { Pay402Config } from "../src/config.js";
import { baseConfig, paymentSignatureHeader, TEST_PAYER } from "./helpers.js";

const ROUTE = "/v1/chat/completions";

function makeApp(
  facilitator: MockFacilitator,
  opts: {
    config?: Partial<Pay402Config>;
    handler?: express.RequestHandler;
    onEvent?: (e: Pay402Event) => void;
  } = {},
): Express {
  const app = express();
  app.use(express.json());
  const config: Pay402Config = baseConfig(opts.config);
  const wall = paymentWall(config, {
    facilitator,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
  const handler: express.RequestHandler =
    opts.handler ??
    ((_req, res) => {
      res.json({ choices: [{ text: "hello world" }] });
    });
  app.post(ROUTE, wall, handler);
  return app;
}

// Response header lookups in superagent are lowercase.
const H_REQUIRED = HEADER_PAYMENT_REQUIRED.toLowerCase();
const H_RESPONSE = HEADER_PAYMENT_RESPONSE.toLowerCase();

describe("express adapter — challenge path (real HTTP)", () => {
  it("unpaid POST gets 402 + decodable PAYMENT-REQUIRED, handler never runs", async () => {
    let handlerRan = false;
    const fac = new MockFacilitator();
    const app = makeApp(fac, {
      handler: (_req, res) => {
        handlerRan = true;
        res.json({ ok: true });
      },
    });

    const r = await request(app).post(ROUTE).send({ model: "test", messages: [] });

    expect(r.status).toBe(402);
    expect(handlerRan).toBe(false);
    expect(fac.verifyCalls).toHaveLength(0);

    const raw = r.headers[H_REQUIRED];
    expect(typeof raw).toBe("string");
    const pr = decodeHeaderJson<PaymentRequired>(raw as string, "PAYMENT-REQUIRED");
    expect(pr.x402Version).toBe(2);
    expect(pr.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    });
  });
});

describe("express adapter — SUCCESS path (real HTTP round trip)", () => {
  it("paid POST gets 200 + handler body + PAYMENT-RESPONSE; verify then settle each called once", async () => {
    const fac = new MockFacilitator();
    const app = makeApp(fac);
    const header = paymentSignatureHeader();

    // Send the header in canonical UPPERCASE — Node lowercases it in transit;
    // this is the exact casing trap the adapter must survive.
    const r = await request(app)
      .post(ROUTE)
      .set("PAYMENT-SIGNATURE", header)
      .send({ model: "test", messages: [{ role: "user", content: "hi" }] });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ choices: [{ text: "hello world" }] });

    expect(fac.verifyCalls).toHaveLength(1);
    expect(fac.settleCalls).toHaveLength(1);

    const raw = r.headers[H_RESPONSE];
    expect(typeof raw).toBe("string");
    const sr = decodeHeaderJson<SettleResponse>(raw as string, "PAYMENT-RESPONSE");
    expect(sr.success).toBe(true);
    expect(sr.payer).toBe(TEST_PAYER);
    expect(sr.network).toBe("eip155:84532");
    expect(sr.transaction).toMatch(/^0x[0-9a-f]+$/);
  });

  it("also matches when the client sends the header in lowercase", async () => {
    const fac = new MockFacilitator();
    const app = makeApp(fac);
    const r = await request(app)
      .post(ROUTE)
      .set("payment-signature", paymentSignatureHeader())
      .send({});
    expect(r.status).toBe(200);
    expect(fac.settleCalls).toHaveLength(1);
  });
});

describe("express adapter — invalid payments (real HTTP)", () => {
  it("garbage PAYMENT-SIGNATURE → 400, handler never runs, no settle", async () => {
    const fac = new MockFacilitator();
    const app = makeApp(fac);
    const r = await request(app).post(ROUTE).set("PAYMENT-SIGNATURE", "!!!garbage!!!").send({});
    expect(r.status).toBe(400);
    expect(fac.verifyCalls).toHaveLength(0);
    expect(fac.settleCalls).toHaveLength(0);
  });

  it("verify rejection → 402 + PAYMENT-RESPONSE with errorReason, handler never runs", async () => {
    const fac = new MockFacilitator({ rejectVerify: "insufficient_funds" });
    const app = makeApp(fac);
    const r = await request(app)
      .post(ROUTE)
      .set("PAYMENT-SIGNATURE", paymentSignatureHeader())
      .send({});

    expect(r.status).toBe(402);
    expect(fac.settleCalls).toHaveLength(0);
    const sr = decodeHeaderJson<SettleResponse>(r.headers[H_RESPONSE] as string, "PAYMENT-RESPONSE");
    expect(sr.success).toBe(false);
    expect(sr.errorReason).toBe("insufficient_funds");
  });
});

describe("express adapter — handler failure leaves client uncharged", () => {
  it("handler 500 → settle is skipped entirely", async () => {
    const fac = new MockFacilitator();
    const app = makeApp(fac, {
      handler: (_req, res) => {
        res.status(500).json({ error: "boom" });
      },
    });
    const r = await request(app)
      .post(ROUTE)
      .set("PAYMENT-SIGNATURE", paymentSignatureHeader())
      .send({});

    expect(r.status).toBe(500);
    expect(fac.verifyCalls).toHaveLength(1);
    expect(fac.settleCalls).toHaveLength(0); // money never moved
  });

  it("handler that throws → express 500, settle skipped", async () => {
    const fac = new MockFacilitator();
    const app = makeApp(fac, {
      handler: () => {
        throw new Error("sync boom");
      },
    });
    const r = await request(app)
      .post(ROUTE)
      .set("PAYMENT-SIGNATURE", paymentSignatureHeader())
      .send({});
    expect(r.status).toBe(500);
    expect(fac.settleCalls).toHaveLength(0);
  });
});

describe("express adapter — settle failure after handler success", () => {
  it("replaces the buffered body with 402 + PAYMENT-RESPONSE", async () => {
    const fac = new MockFacilitator({ rejectSettle: "invalid_transaction_state" });
    const app = makeApp(fac);
    const r = await request(app)
      .post(ROUTE)
      .set("PAYMENT-SIGNATURE", paymentSignatureHeader())
      .send({});

    expect(r.status).toBe(402);
    expect(r.body).toEqual({ error: "invalid_transaction_state" });
    const sr = decodeHeaderJson<SettleResponse>(r.headers[H_RESPONSE] as string, "PAYMENT-RESPONSE");
    expect(sr.success).toBe(false);
    expect(sr.errorReason).toBe("invalid_transaction_state");
  });
});

describe("express adapter — facilitator infrastructure failures", () => {
  it("verify timeout → 500, handler never runs, never silently passes", async () => {
    const fac = new MockFacilitator({ latencyMs: 500 });
    const app = makeApp(fac, { config: { facilitatorTimeoutMs: 50 } });
    const r = await request(app)
      .post(ROUTE)
      .set("PAYMENT-SIGNATURE", paymentSignatureHeader())
      .send({});
    expect(r.status).toBe(500);
    expect(fac.settleCalls).toHaveLength(0);
  });
});

describe("express adapter — event sink wiring", () => {
  it("emits challenge.issued (payerless) for unpaid and payment.settled (with payer) for paid", async () => {
    const events: Pay402Event[] = [];
    const fac = new MockFacilitator();
    const app = makeApp(fac, { onEvent: (e) => events.push(e) });

    await request(app).post(ROUTE).send({});
    await request(app).post(ROUTE).set("PAYMENT-SIGNATURE", paymentSignatureHeader()).send({});

    expect(events.map((e) => e.kind)).toEqual(["challenge.issued", "payment.settled"]);
    const challenge = events[0];
    expect(challenge && !("payer" in challenge)).toBe(true); // payerless by type
    const settled = events[1];
    if (settled?.kind === "payment.settled") {
      expect(settled.payer).toBe(TEST_PAYER);
      expect(settled.amount).toBe("10000");
      expect(settled.transaction).toMatch(/^0x/);
    } else {
      throw new Error("expected payment.settled");
    }
  });

  it("emits settlement.skipped when the handler fails after verify", async () => {
    const events: Pay402Event[] = [];
    const fac = new MockFacilitator();
    const app = makeApp(fac, {
      onEvent: (e) => events.push(e),
      handler: (_req, res) => {
        res.status(503).json({ error: "down" });
      },
    });
    await request(app).post(ROUTE).set("PAYMENT-SIGNATURE", paymentSignatureHeader()).send({});
    expect(events.map((e) => e.kind)).toEqual(["settlement.skipped"]);
    const skipped = events[0];
    if (skipped?.kind === "settlement.skipped") {
      expect(skipped.payer).toBe(TEST_PAYER);
      expect(skipped.statusCode).toBe(503);
      expect(skipped.reason).toBe("handler_failed");
    } else {
      throw new Error("expected settlement.skipped");
    }
  });
});
