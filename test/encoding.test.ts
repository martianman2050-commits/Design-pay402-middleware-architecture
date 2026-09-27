import { describe, expect, it } from "vitest";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  INCOMING_HEADER_PAYMENT_SIGNATURE,
  HeaderDecodeError,
  decodeHeaderJson,
  encodeHeaderJson,
} from "../src/encoding.js";

describe("header constants match spec transports-v2/http.md Header Summary", () => {
  it("uses the v2 canonical header names (NOT v1's X-PAYMENT)", () => {
    expect(HEADER_PAYMENT_REQUIRED).toBe("PAYMENT-REQUIRED");
    expect(HEADER_PAYMENT_SIGNATURE).toBe("PAYMENT-SIGNATURE");
    expect(HEADER_PAYMENT_RESPONSE).toBe("PAYMENT-RESPONSE");
  });

  it("provides lowercase lookup names for incoming Node/Express headers", () => {
    expect(INCOMING_HEADER_PAYMENT_SIGNATURE).toBe("payment-signature");
  });
});

describe("base64 round-trip", () => {
  it("encodes and decodes an object exactly", () => {
    const value = { x402Version: 2, hello: "world", n: [1, 2, 3] };
    const encoded = encodeHeaderJson(value);
    expect(typeof encoded).toBe("string");
    expect(encoded).not.toContain("{"); // really base64, not raw JSON
    expect(decodeHeaderJson<typeof value>(encoded, "TEST")).toEqual(value);
  });

  it("matches the spec example encoding shape (base64 of compact JSON)", () => {
    const encoded = encodeHeaderJson({ a: 1 });
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe('{"a":1}');
  });

  it("throws HeaderDecodeError on invalid JSON content", () => {
    const bad = Buffer.from("not json", "utf8").toString("base64");
    expect(() => decodeHeaderJson(bad, "PAYMENT-SIGNATURE")).toThrow(HeaderDecodeError);
    expect(() => decodeHeaderJson(bad, "PAYMENT-SIGNATURE")).toThrow(/PAYMENT-SIGNATURE/);
  });

  it("throws HeaderDecodeError on non-base64 garbage that yields invalid JSON", () => {
    expect(() => decodeHeaderJson("!!!not-base64!!!", "PAYMENT-SIGNATURE")).toThrow(HeaderDecodeError);
  });
});
