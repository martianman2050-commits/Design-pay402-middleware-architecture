// Dashboard tests. Hermetic: records are built in-memory per test; the
// file-backed test uses a beforeEach-scoped temp dir. No top-level shared
// mutable state.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DASHBOARD_STAT_KEYS,
  computeStats,
  computeStatsFromLedger,
  formatAtomicDecimal,
} from "../src/dashboard.js";
import { createLedger } from "../src/ledger.js";
import type { LedgerRecord } from "../src/ledger.js";
import type { Pay402Event } from "../src/events.js";

const TS = "2026-09-27T12:00:00.000Z";
const URL = "https://api.example.com/v1/chat/completions";
const NET = "eip155:84532";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// Minimal helper to turn an event into a LedgerRecord for pure computeStats
// tests (seq/id/hash are irrelevant to aggregation).
function rec(event: Pay402Event, seq: number): LedgerRecord {
  return { ...event, seq, id: `id-${seq}`, prevHash: "0", hash: "h" } as LedgerRecord;
}

function settled(payer: string | null, amount: string, seq: number): LedgerRecord {
  return rec(
    {
      kind: "payment.settled",
      ts: TS,
      resourceUrl: URL,
      method: "POST",
      payer,
      amount,
      network: NET,
      asset: ASSET,
      transaction: "0x" + "ab".repeat(32),
    },
    seq,
  );
}

describe("computeStats — payerless exclusion contract", () => {
  it("counts challenges/errors but NEVER folds them into payer counts", () => {
    const records: LedgerRecord[] = [
      rec({ kind: "challenge.issued", ts: TS, resourceUrl: URL, method: "POST", amount: "10000", network: NET, asset: ASSET }, 1),
      rec({ kind: "challenge.issued", ts: TS, resourceUrl: URL, method: "POST", amount: "10000", network: NET, asset: ASSET }, 2),
      rec({ kind: "error.occurred", ts: TS, resourceUrl: URL, method: "POST", error: "timeout" }, 3),
      settled("0x" + "11".repeat(20), "10000", 4),
    ];
    const s = computeStats(records);
    expect(s.totalEvents).toBe(4);
    expect(s.challenges).toBe(2);
    expect(s.errors).toBe(1);
    expect(s.settledCount).toBe(1);
    // Only the ONE real settled payer counts — not the 2 challenges + 1 error.
    expect(s.uniquePayerCount).toBe(1);
    expect(s.perPayer).toHaveLength(1);
    expect(s.perPayer[0]?.payer).toBe("0x" + "11".repeat(20));
  });

  it("excludes settled records with null payer from per-payer stats but keeps them in the total", () => {
    const records: LedgerRecord[] = [
      settled("0x" + "22".repeat(20), "10000", 1),
      settled(null, "5000", 2), // facilitator omitted payer
    ];
    const s = computeStats(records);
    expect(s.settledCount).toBe(2);
    expect(s.totalSettledAtomic).toBe("15000");
    expect(s.uniquePayerCount).toBe(1);
    expect(s.perPayer).toHaveLength(1);
  });

  it("does not attribute rejected payments to payers", () => {
    const records: LedgerRecord[] = [
      rec({ kind: "payment.rejected", ts: TS, resourceUrl: URL, method: "POST", status: 402, error: "insufficient_funds", payer: "0x" + "33".repeat(20), amount: "10000", network: NET }, 1),
      settled("0x" + "44".repeat(20), "10000", 2),
    ];
    const s = computeStats(records);
    expect(s.rejectedCount).toBe(1);
    expect(s.uniquePayerCount).toBe(1);
    expect(s.perPayer[0]?.payer).toBe("0x" + "44".repeat(20));
  });
});

describe("computeStats — BigInt-exact summation beyond float range", () => {
  it("sums amounts that float64 cannot represent, exactly", () => {
    // Expected sum computed independently by debug/bigsum.mjs (node BigInt):
    //   amounts: 9007199254740993 + 9007199254740993 + 123456789012345678901234567890
    //   BigInt sum      : 123456789012363693299744049876
    //   float64 sum     : 1.234567890123637e+29  (NOT exact)
    const records: LedgerRecord[] = [
      settled("0x" + "aa".repeat(20), "9007199254740993", 1),
      settled("0x" + "aa".repeat(20), "9007199254740993", 2),
      settled("0x" + "bb".repeat(20), "123456789012345678901234567890", 3),
    ];
    const s = computeStats(records);
    expect(s.totalSettledAtomic).toBe("123456789012363693299744049876");
    // Prove the naive float path would have been wrong:
    const floatSum = ["9007199254740993", "9007199254740993", "123456789012345678901234567890"]
      .reduce((a, x) => a + globalThis.Number(x), 0)
      .toFixed(0);
    expect(floatSum).not.toBe("123456789012363693299744049876");
    // Per-payer sums are exact too.
    const aa = s.perPayer.find((p) => p.payer === "0x" + "aa".repeat(20));
    expect(aa?.totalSettledAtomic).toBe("18014398509481986"); // 2 * (2^53+1)
  });
});

describe("computeStats — no secrets leak", () => {
  it("serializes ONLY whitelisted aggregate keys (no apiKey/secret/authorization)", () => {
    const records: LedgerRecord[] = [settled("0x" + "cc".repeat(20), "10000", 1)];
    const s = computeStats(records);
    const json = JSON.stringify(s);
    expect(Object.keys(s).sort()).toEqual([...DASHBOARD_STAT_KEYS].sort());
    for (const banned of ["apiKey", "secret", "authorization", "signature", "privateKey", "password"]) {
      expect(json.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

describe("formatAtomicDecimal — BigInt/string only", () => {
  it("formats USDC (6 decimals) exactly", () => {
    expect(formatAtomicDecimal("10000", 6)).toBe("0.010000");
    expect(formatAtomicDecimal("1000000", 6)).toBe("1.000000");
    expect(formatAtomicDecimal("1", 6)).toBe("0.000001");
    expect(formatAtomicDecimal("0", 6)).toBe("0.000000");
  });

  it("formats huge values without precision loss", () => {
    // Expected value computed via node BigInt, not hand-typed:
    //   v = 123456789012363693299744049876n; scale = 10n ** 6n
    //   int part : (v / scale) = 123456789012363693299744
    //   frac part: (v % scale).toString().padStart(6,"0") = "049876"
    expect(formatAtomicDecimal("123456789012363693299744049876", 6)).toBe(
      "123456789012363693299744.049876",
    );
  });
});

describe("computeStatsFromLedger — read-only against a real ledger", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pay402-dash-"));
    filePath = join(dir, "ledger.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("aggregates a persisted ledger and does not mutate it", async () => {
    const ledger = createLedger(filePath);
    ledger.append({ kind: "challenge.issued", ts: TS, resourceUrl: URL, method: "POST", amount: "10000", network: NET, asset: ASSET });
    ledger.append({ kind: "payment.settled", ts: TS, resourceUrl: URL, method: "POST", payer: "0x" + "dd".repeat(20), amount: "10000", network: NET, asset: ASSET, transaction: "0x" + "ee".repeat(32) });
    await ledger.flush();

    const before = await ledger.read();
    const s = await computeStatsFromLedger(ledger);
    const after = await ledger.read();

    expect(s.totalEvents).toBe(2);
    expect(s.challenges).toBe(1);
    expect(s.settledCount).toBe(1);
    expect(s.uniquePayerCount).toBe(1);
    expect(s.totalSettledAtomic).toBe("10000");
    // Read-only: the ledger is unchanged (same length, same hashes).
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.hash)).toEqual(before.map((r) => r.hash));
  });
});
