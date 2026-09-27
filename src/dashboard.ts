// Read-only dashboard aggregation over ledger records.
//
// Contracts enforced here (and tested in test/dashboard.test.ts):
// 1. NO WRITE PATH — this module only reads records; it never touches the
//    ledger file or emits events.
// 2. NO SECRETS — output is a fixed whitelist of aggregate fields. Ledger
//    records cannot contain facilitator credentials by construction (see
//    src/events.ts), and this module never imports config/CDP modules.
// 3. PAYERLESS EXCLUSION — challenge.issued and error.occurred records have
//    no payer field at all; payment.rejected may carry payer: null. Neither
//    ever contributes to uniquePayerCount or perPayer stats. Only non-null
//    payer strings are aggregated.
// 4. BIGINT-ONLY MATH — every amount summation/formatting uses BigInt and
//    integer strings. Number()/parseFloat() are banned in src/ by eslint.

import type { LedgerRecord } from "./ledger.js";
import { parseAtomicString } from "./amount.js";

export interface PayerStat {
  payer: string;
  /** Count of successfully settled payments by this payer. */
  settledCount: number;
  /** Exact sum of settled amounts, atomic-unit integer string. */
  totalSettledAtomic: string;
}

export interface DashboardStats {
  /** Total records in the ledger. */
  totalEvents: number;
  /** challenge.issued count (payerless). */
  challenges: number;
  /** error.occurred count (payerless). */
  errors: number;
  /** payment.settled count. */
  settledCount: number;
  /** payment.rejected count. */
  rejectedCount: number;
  /** settlement.skipped count (handler failed after verify). */
  skippedCount: number;
  /** Exact sum of ALL settled amounts, atomic-unit integer string. */
  totalSettledAtomic: string;
  /** Distinct non-null payers seen on settled payments ONLY. */
  uniquePayerCount: number;
  /** Per-payer settled revenue, sorted by total desc then payer asc. */
  perPayer: PayerStat[];
}

/** The exact whitelist of keys a serialized DashboardStats may contain. */
export const DASHBOARD_STAT_KEYS = [
  "totalEvents",
  "challenges",
  "errors",
  "settledCount",
  "rejectedCount",
  "skippedCount",
  "totalSettledAtomic",
  "uniquePayerCount",
  "perPayer",
] as const;

/**
 * Aggregate ledger records into dashboard stats. Pure function of its input.
 */
export function computeStats(records: readonly LedgerRecord[]): DashboardStats {
  let totalEvents = 0;
  let challenges = 0;
  let errors = 0;
  let settledCount = 0;
  let rejectedCount = 0;
  let skippedCount = 0;
  let totalSettled = 0n;
  const byPayer = new Map<string, { settledCount: number; total: bigint }>();

  for (const r of records) {
    totalEvents += 1;
    switch (r.kind) {
      case "challenge.issued":
        // Payerless by construction — counted, never attributed.
        challenges += 1;
        break;
      case "error.occurred":
        // Payerless by construction — counted, never attributed.
        errors += 1;
        break;
      case "payment.rejected":
        rejectedCount += 1;
        // Deliberately NOT aggregated per-payer: a rejected payment is not
        // revenue, and payer may be null (malformed payload).
        break;
      case "settlement.skipped":
        skippedCount += 1;
        break;
      case "payment.settled": {
        settledCount += 1;
        const amount = parseAtomicString(r.amount);
        totalSettled += amount;
        if (r.payer !== null) {
          const entry = byPayer.get(r.payer) ?? { settledCount: 0, total: 0n };
          entry.settledCount += 1;
          entry.total += amount;
          byPayer.set(r.payer, entry);
        }
        break;
      }
    }
  }

  const perPayer: PayerStat[] = [...byPayer.entries()]
    .map(([payer, v]) => ({
      payer,
      settledCount: v.settledCount,
      totalSettledAtomic: v.total.toString(),
    }))
    .sort((a, b) => {
      const diff = BigInt(b.totalSettledAtomic) - BigInt(a.totalSettledAtomic);
      if (diff > 0n) return 1;
      if (diff < 0n) return -1;
      return a.payer < b.payer ? -1 : a.payer > b.payer ? 1 : 0;
    });

  return {
    totalEvents,
    challenges,
    errors,
    settledCount,
    rejectedCount,
    skippedCount,
    totalSettledAtomic: totalSettled.toString(),
    uniquePayerCount: byPayer.size,
    perPayer,
  };
}

/**
 * Format an atomic-unit integer string as an exact fixed-point decimal
 * string (e.g. USDC: formatAtomicDecimal("10000", 6) === "0.010000").
 * BigInt division/modulo only — never Number.
 */
export function formatAtomicDecimal(atomic: string, decimals: number): string {
  const value = parseAtomicString(atomic);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`decimals must be a non-negative integer, got: ${decimals}`);
  }
  const scale = 10n ** BigInt(decimals);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const intPart = abs / scale;
  const fracPart = (abs % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${intPart.toString()}.${fracPart}`;
}

/** Convenience: read records from a ledger and aggregate. Read-only. */
export async function computeStatsFromLedger(ledger: {
  read(): Promise<LedgerRecord[]>;
}): Promise<DashboardStats> {
  return computeStats(await ledger.read());
}
