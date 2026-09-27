// Append-only JSONL ledger for pay402 events, structured for a future
// reputation/trust layer (monotonic seq, stable ids, payer field present
// ONLY on event kinds that can carry one — see src/events.ts contract).
//
// Durability model: one JSON object per line, appended atomically per line.
// Writes are serialized through an internal promise chain so concurrent
// requests cannot interleave partial lines.

import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Pay402Event } from "./events.js";

export interface LedgerMeta {
  /** Monotonic per-ledger sequence number, continuing across restarts. */
  seq: number;
  /** Unique record id. */
  id: string;
  /** SHA-256 of the previous record's `hash` (genesis: 64 zeros). */
  prevHash: string;
  /** SHA-256 over the record's full content (all fields except `hash`). */
  hash: string;
}

/**
 * Distribute the meta fields over each Pay402Event variant so that narrowing
 * a LedgerRecord by `kind` also reveals that variant's own fields (payer,
 * amount, etc.). A plain `Pay402Event & LedgerMeta` intersection would not
 * distribute and would hide variant-specific properties.
 */
export type LedgerRecord = Pay402Event extends infer U
  ? U extends Pay402Event
    ? U & LedgerMeta
    : never
  : never;

export class LedgerCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerCorruptionError";
  }
}

const GENESIS_HASH = "0".repeat(64);

/** Content hash over every field except `hash` itself. */
function recordHash(fields: object): string {
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex");
}

/**
 * Copy of a record without its `hash` field. Key order is preserved:
 * appends serialize {...event, seq, id, prevHash} and `hash` is added last,
 * so JSON.parse(...) minus `hash` re-serializes byte-identically.
 */
function stripHash(record: LedgerRecord): Record<string, unknown> {
  const { hash: _hash, ...rest } = record as unknown as Record<string, unknown>;
  return rest;
}

export class Ledger {
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;
  private nextSeq = 1;
  private lastHash = GENESIS_HASH;

  constructor(private filePath: string) {}

  /** EventSink-compatible append. Fire-and-forget; errors surface via flush(). */
  append(event: Pay402Event): void {
    this.queue = this.queue.then(() => this.appendNow(event)).catch((e: unknown) => {
      throw e;
    });
  }

  /** Wait for all queued appends to hit disk. Throws if any append failed. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    let existing: LedgerRecord[] = [];
    try {
      existing = await this.readRaw();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const last = existing[existing.length - 1];
    if (last) {
      this.nextSeq = last.seq + 1;
      this.lastHash = last.hash;
    }
    this.initialized = true;
  }

  private async appendNow(event: Pay402Event): Promise<void> {
    await this.ensureInit();
    const base = {
      ...event,
      seq: this.nextSeq++,
      id: randomUUID(),
      prevHash: this.lastHash,
    };
    // Cast is sound: `base` is a concrete Pay402Event variant plus meta;
    // TS cannot prove that through the distributive LedgerRecord union.
    const record = { ...base, hash: recordHash(base) } as LedgerRecord;
    this.lastHash = record.hash;
    const line = JSON.stringify(record) + "\n";
    const fh = await open(this.filePath, "a");
    try {
      await fh.appendFile(line, "utf8");
      await fh.sync(); // fsync: append-only money logs must survive crashes
    } finally {
      await fh.close();
    }
  }

  private async readRaw(): Promise<LedgerRecord[]> {
    const content = await readFile(this.filePath, "utf8");
    const records: LedgerRecord[] = [];
    for (const [i, line] of content.split("\n").entries()) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new LedgerCorruptionError(`ledger line ${i + 1} is not valid JSON`);
      }
      if (parsed === null || typeof parsed !== "object") {
        throw new LedgerCorruptionError(`ledger line ${i + 1} is not an object`);
      }
      records.push(parsed as LedgerRecord);
    }
    return records;
  }

  /**
   * Read all records and verify BOTH the content hash of every record and the
   * hash chain across records. Any field edit, removal, reorder, or insertion
   * throws LedgerCorruptionError.
   */
  async read(): Promise<LedgerRecord[]> {
    await this.queue;
    const records = await this.readRaw();
    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const r of records) {
      if (r.seq !== expectedSeq) {
        throw new LedgerCorruptionError(`seq gap: expected ${expectedSeq}, found ${r.seq}`);
      }
      if (r.prevHash !== expectedPrev) {
        throw new LedgerCorruptionError(`hash chain broken at seq ${r.seq}`);
      }
      if (recordHash(stripHash(r)) !== r.hash) {
        throw new LedgerCorruptionError(`record content tampered at seq ${r.seq}`);
      }
      expectedSeq = r.seq + 1;
      expectedPrev = r.hash;
    }
    return records;
  }
}

export function createLedger(filePath: string): Ledger {
  return new Ledger(filePath);
}

/** Test/dev helper: atomically replace a ledger file (used to simulate tampering). */
export async function overwriteLedgerFile(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  await open(tmp, "w").then(async (fh) => {
    try {
      await fh.appendFile(content, "utf8");
    } finally {
      await fh.close();
    }
  });
  await rename(tmp, filePath);
}
