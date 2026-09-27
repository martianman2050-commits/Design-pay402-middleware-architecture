// Ledger tests. Hermetic: every test creates its own temp file inside
// beforeEach-scoped state; nothing is shared across files or tests and no
// top-level code mutates global state.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, LedgerCorruptionError, createLedger } from "../src/ledger.js";
import type { Pay402Event } from "../src/events.js";

const TS = "2026-09-27T12:00:00.000Z";

function settledEvent(payer: string, amount: string): Pay402Event {
  return {
    kind: "payment.settled",
    ts: TS,
    resourceUrl: "https://api.example.com/v1/chat/completions",
    method: "POST",
    payer,
    amount,
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    transaction: "0xabc123",
  };
}

function challengeEvent(): Pay402Event {
  return {
    kind: "challenge.issued",
    ts: TS,
    resourceUrl: "https://api.example.com/v1/chat/completions",
    method: "POST",
    amount: "10000",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };
}

function errorEvent(): Pay402Event {
  return {
    kind: "error.occurred",
    ts: TS,
    resourceUrl: "https://api.example.com/v1/chat/completions",
    method: "POST",
    error: "facilitator verify timed out after 50ms",
  };
}

describe("Ledger", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pay402-ledger-"));
    filePath = join(dir, "ledger.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips every event kind with fields intact", async () => {
    const ledger = createLedger(filePath);
    const events: Pay402Event[] = [
      challengeEvent(),
      settledEvent("0xpayer1".padEnd(42, "0"), "10000"),
      {
        kind: "payment.rejected",
        ts: TS,
        resourceUrl: "https://api.example.com/v1/chat/completions",
        method: "POST",
        status: 402,
        error: "insufficient_funds",
        payer: null,
        amount: "10000",
        network: "eip155:84532",
      },
      {
        kind: "settlement.skipped",
        ts: TS,
        resourceUrl: "https://api.example.com/v1/chat/completions",
        method: "POST",
        payer: "0xpayer2".padEnd(42, "0"),
        amount: "10000",
        network: "eip155:84532",
        reason: "handler_failed",
        statusCode: 500,
      },
      errorEvent(),
    ];
    for (const e of events) ledger.append(e);
    await ledger.flush();

    const records = await ledger.read();
    expect(records).toHaveLength(5);
    expect(records.map((r) => r.kind)).toEqual(events.map((e) => e.kind));
    // Amounts stay exact integer strings through storage.
    const settledRec = records[1];
    expect(settledRec?.kind).toBe("payment.settled");
    if (settledRec?.kind === "payment.settled") {
      expect(settledRec.amount).toBe("10000");
      expect(typeof settledRec.amount).toBe("string");
    }
  });

  it("assigns monotonic seq starting at 1", async () => {
    const ledger = createLedger(filePath);
    ledger.append(challengeEvent());
    ledger.append(challengeEvent());
    ledger.append(challengeEvent());
    await ledger.flush();
    const records = await ledger.read();
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("continues seq and hash chain across reopen", async () => {
    const l1 = createLedger(filePath);
    l1.append(challengeEvent());
    l1.append(settledEvent("0x" + "11".repeat(20), "10000"));
    await l1.flush();

    const l2 = new Ledger(filePath);
    l2.append(challengeEvent());
    await l2.flush();

    const records = await l2.read();
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("PAYERLESS CONTRACT: challenge.issued and error.occurred records have no payer key at all", async () => {
    const ledger = createLedger(filePath);
    ledger.append(challengeEvent());
    ledger.append(errorEvent());
    await ledger.flush();

    const records = await ledger.read();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.kind === "challenge.issued" || r.kind === "error.occurred").toBe(true);
      expect("payer" in r).toBe(false);
    }
    // And the raw serialized line contains no payer field either:
    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain('"payer"');
  });

  it("payer-carrying kinds expose payer (possibly null)", async () => {
    const ledger = createLedger(filePath);
    ledger.append(settledEvent("0x" + "22".repeat(20), "10000"));
    await ledger.flush();
    const [r] = await ledger.read();
    expect(r && "payer" in r).toBe(true);
    if (r?.kind === "payment.settled") expect(r.payer).toBe("0x" + "22".repeat(20));
  });

  it("serializes concurrent appends without corrupting the chain", async () => {
    const ledger = createLedger(filePath);
    const payers = Array.from({ length: 25 }, (_, i) => "0x" + i.toString(16).padStart(40, "0"));
    // Fire all appends without awaiting between them.
    for (const p of payers) ledger.append(settledEvent(p, "10000"));
    await ledger.flush();

    const records = await ledger.read(); // throws if chain/seq broken
    expect(records).toHaveLength(25);
    expect(records.map((r) => r.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    const storedPayers = records.map((r) => (r.kind === "payment.settled" ? r.payer : null));
    expect(new Set(storedPayers).size).toBe(25);
  });

  it("detects tampering: modified amount field breaks the content hash", async () => {
    const ledger = createLedger(filePath);
    ledger.append(settledEvent("0x" + "33".repeat(20), "10000"));
    ledger.append(settledEvent("0x" + "44".repeat(20), "20000"));
    await ledger.flush();

    const raw = await readFile(filePath, "utf8");
    // Attacker tries to inflate an amount.
    const tampered = raw.replace('"amount":"20000"', '"amount":"99999999"');
    expect(tampered).not.toBe(raw);
    await writeFile(filePath, tampered, "utf8");

    const l2 = new Ledger(filePath);
    await expect(l2.read()).rejects.toThrow(LedgerCorruptionError);
    await expect(l2.read()).rejects.toThrow(/content tampered/);
  });

  it("detects tampering: rewriting a record id breaks the chain", async () => {
    const ledger = createLedger(filePath);
    ledger.append(settledEvent("0x" + "55".repeat(20), "10000"));
    ledger.append(settledEvent("0x" + "66".repeat(20), "20000"));
    await ledger.flush();

    const raw = await readFile(filePath, "utf8");
    const lines = raw.trimEnd().split("\n");
    const first = JSON.parse(lines[0] as string) as { id: string };
    first.id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    lines[0] = JSON.stringify(first);
    await writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const l2 = new Ledger(filePath);
    await expect(l2.read()).rejects.toThrow(LedgerCorruptionError);
  });

  it("detects tampering: deleting a middle record breaks the chain", async () => {
    const ledger = createLedger(filePath);
    ledger.append(settledEvent("0x" + "77".repeat(20), "10000"));
    ledger.append(settledEvent("0x" + "88".repeat(20), "20000"));
    ledger.append(settledEvent("0x" + "99".repeat(20), "30000"));
    await ledger.flush();

    const raw = await readFile(filePath, "utf8");
    const lines = raw.trimEnd().split("\n");
    lines.splice(1, 1); // remove middle record
    await writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const l2 = new Ledger(filePath);
    await expect(l2.read()).rejects.toThrow(LedgerCorruptionError);
  });

  it("rejects corrupt (non-JSON) lines", async () => {
    await writeFile(filePath, "not json at all\n", "utf8");
    const ledger = new Ledger(filePath);
    await expect(ledger.read()).rejects.toThrow(LedgerCorruptionError);
  });
});
