import { describe, expect, it } from "vitest";
import { processPayment, type CoreDecision } from "../src/core.js";
import { resolveConfig } from "../src/config.js";
import { MockFacilitator } from "../src/facilitator/mock.js";
import type { FacilitatorClient } from "../src/types.js";
import { encodeHeaderJson } from "../src/encoding.js";
import {
  baseConfig,
  buildPaymentPayload,
  paymentSignatureHeader,
  TEST_RESOURCE_URL,
} from "./helpers.js";

function makeInput(
  facilitator: FacilitatorClient,
  header: string | undefined,
  cfg = baseConfig(),
) {
  return {
    paymentSignatureHeader: header,
    resolved: resolveConfig(cfg),
    facilitator,
    resourceUrl: TEST_RESOURCE_URL,
  };
}

describe("processPayment — challenge path (no payment header)", () => {
  it("returns a 402 challenge with spec-correct PaymentRequired when header is absent", async () => {
    const fac = new MockFacilitator();
    const d = await processPayment(makeInput(fac, undefined));
    expect(d.kind).toBe("challenge");
    if (d.kind !== "challenge") return;
    expect(d.paymentRequired.x402Version).toBe(2);
    expect(d.paymentRequired.error).toBe("PAYMENT-SIGNATURE header is required");
    expect(d.paymentRequired.resource.url).toBe(TEST_RESOURCE_URL);
    expect(d.paymentRequired.accepts).toHaveLength(1);
    expect(d.paymentRequired.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
    });
    // No facilitator calls on a pure challenge.
    expect(fac.verifyCalls).toHaveLength(0);
    expect(fac.settleCalls).toHaveLength(0);
  });

  it("treats an empty/whitespace header as a challenge", async () => {
    const d = await processPayment(makeInput(new MockFacilitator(), "   "));
    expect(d.kind).toBe("challenge");
  });
});

describe("processPayment — malformed payload (→400)", () => {
  it("rejects a non-base64/invalid-JSON header with status 400", async () => {
    const d = await processPayment(makeInput(new MockFacilitator(), "!!!garbage!!!"));
    expect(d.kind).toBe("invalid");
    if (d.kind !== "invalid") return;
    expect(d.status).toBe(400);
  });

  it("rejects a payload with the wrong x402Version (e.g. legacy v1)", async () => {
    const bad = encodeHeaderJson({ x402Version: 1, accepted: {}, payload: {} });
    const d = await processPayment(makeInput(new MockFacilitator(), bad));
    expect(d.kind).toBe("invalid");
    if (d.kind !== "invalid") return;
    expect(d.status).toBe(400);
  });

  it("rejects a payload missing accepted/payload objects", async () => {
    const bad = encodeHeaderJson({ x402Version: 2 });
    const d = await processPayment(makeInput(new MockFacilitator(), bad));
    expect(d.kind).toBe("invalid");
    if (d.kind === "invalid") expect(d.status).toBe(400);
  });
});

describe("processPayment — client cannot tamper with requirements (→400)", () => {
  it("rejects when accepted.amount is lower than the server requirement", async () => {
    const payload = buildPaymentPayload();
    payload.accepted = { ...payload.accepted, amount: "1" }; // try to pay less
    const d = await processPayment(makeInput(new MockFacilitator(), encodeHeaderJson(payload)));
    expect(d.kind).toBe("invalid");
    if (d.kind !== "invalid") return;
    expect(d.status).toBe(400);
    expect(d.error).toMatch(/do not match/);
  });

  it("rejects when accepted.payTo is redirected to another address", async () => {
    const payload = buildPaymentPayload();
    payload.accepted = { ...payload.accepted, payTo: "0x0000000000000000000000000000000000000001" };
    const d = await processPayment(makeInput(new MockFacilitator(), encodeHeaderJson(payload)));
    expect(d.kind).toBe("invalid");
    if (d.kind === "invalid") expect(d.status).toBe(400);
  });
});

describe("processPayment — verify rejection (→402 with PAYMENT-RESPONSE)", () => {
  it("maps facilitator isValid:false to a 402 invalid decision carrying a SettleResponse", async () => {
    const fac = new MockFacilitator({ rejectVerify: "insufficient_funds" });
    const d = await processPayment(makeInput(fac, paymentSignatureHeader()));
    expect(d.kind).toBe("invalid");
    if (d.kind !== "invalid") return;
    expect(d.status).toBe(402);
    expect(d.paymentResponse?.success).toBe(false);
    expect(d.paymentResponse?.errorReason).toBe("insufficient_funds");
    expect(d.paymentResponse?.network).toBe("eip155:84532");
    // settle must NOT have been attempted after a failed verify.
    expect(fac.settleCalls).toHaveLength(0);
  });
});

describe("processPayment — SUCCESS / PASS path (the critical one)", () => {
  it("verifies, exposes payer + settle(), and settle returns success", async () => {
    const fac = new MockFacilitator();
    const header = paymentSignatureHeader();
    const d: CoreDecision = await processPayment(makeInput(fac, header));

    expect(d.kind).toBe("verified");
    if (d.kind !== "verified") return;

    expect(d.payer).toBeDefined();
    expect(d.verifyResponse.isValid).toBe(true);

    // verify used the SERVER-BUILT requirements, not the client's copy.
    expect(fac.verifyCalls).toHaveLength(1);
    expect(fac.verifyCalls[0]?.paymentRequirements.amount).toBe("10000");

    // Adapter runs the resource handler here, then settles.
    const outcome = await d.settle();
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    expect(outcome.response.success).toBe(true);
    expect(outcome.response.transaction).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(outcome.response.network).toBe("eip155:84532");
    expect(fac.settleCalls).toHaveLength(1);
  });

  it("does not settle until the adapter calls settle() (verify → resource → settle ordering)", async () => {
    const fac = new MockFacilitator();
    const d = await processPayment(makeInput(fac, paymentSignatureHeader()));
    if (d.kind !== "verified") throw new Error("expected verified");
    // Before calling settle, no settle has happened.
    expect(fac.settleCalls).toHaveLength(0);
    await d.settle();
    expect(fac.settleCalls).toHaveLength(1);
  });
});

describe("processPayment — settle failure surfaced to adapter", () => {
  it("returns a non-success SettleOutcome when settle fails", async () => {
    const fac = new MockFacilitator({ rejectSettle: "invalid_transaction_state" });
    const d = await processPayment(makeInput(fac, paymentSignatureHeader()));
    if (d.kind !== "verified") throw new Error("expected verified");
    const outcome = await d.settle();
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.response.errorReason).toBe("invalid_transaction_state");
  });
});

describe("processPayment — facilitator timeout / unreachable (→500, never silently pass)", () => {
  it("returns status 500 when verify exceeds the timeout", async () => {
    const fac = new MockFacilitator({ latencyMs: 500 });
    const cfg = baseConfig({ facilitatorTimeoutMs: 50 });
    const d = await processPayment(makeInput(fac, paymentSignatureHeader(), cfg));
    expect(d.kind).toBe("error");
    if (d.kind !== "error") return;
    expect(d.status).toBe(500);
    expect(d.error).toMatch(/timed out/);
  });

  it("returns status 500 when the facilitator client throws", async () => {
    const throwing: FacilitatorClient = {
      async verify() {
        throw new Error("ECONNREFUSED");
      },
      async settle() {
        throw new Error("ECONNREFUSED");
      },
    };
    const d = await processPayment(makeInput(throwing, paymentSignatureHeader()));
    expect(d.kind).toBe("error");
    if (d.kind === "error") expect(d.status).toBe(500);
  });
});
