// Example: a metered LLM inference endpoint behind pay402.
//
//   POST /v1/chat/completions — costs $0.01 USDC per request (default:
//                               Base Sepolia testnet, eip155:84532)
//   GET  /dashboard           — read-only revenue view over the ledger
//
// The "LLM" is a deterministic mock: the point of this example is the
// payment plumbing, not the model. Swap the handler body for a real model
// call and everything else stays the same.

import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { paymentWall } from "../../src/express.js";
import { createLedger, type Ledger } from "../../src/ledger.js";
import { computeStatsFromLedger, formatAtomicDecimal } from "../../src/dashboard.js";
import type { Pay402Config } from "../../src/config.js";
import type { FacilitatorClient } from "../../src/types.js";

/** Demo recipient wallet. Holds no funds; replace with your own address. */
export const DEMO_PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

export const DEFAULT_LLM_CONFIG: Pay402Config = {
  price: "$0.01",
  network: "eip155:84532", // Base Sepolia testnet — safe default for an example
  payTo: DEMO_PAY_TO,
  serviceName: "mock-llm",
  description: "Mock LLM chat completion, $0.01 USDC per request",
};

export interface LlmServerOptions {
  facilitator: FacilitatorClient;
  ledgerPath: string;
  config?: Pay402Config;
}

export interface LlmServer {
  app: Express;
  ledger: Ledger;
}

interface ChatMessage {
  role?: string;
  content?: string;
}

export function createLlmServer(options: LlmServerOptions): LlmServer {
  const config = options.config ?? DEFAULT_LLM_CONFIG;
  const ledger = createLedger(options.ledgerPath);
  const app = express();
  app.use(express.json());

  app.post(
    "/v1/chat/completions",
    paymentWall(config, {
      facilitator: options.facilitator,
      onEvent: (event) => ledger.append(event),
    }),
    (req, res) => {
      const body = req.body as { model?: string; messages?: ChatMessage[] } | undefined;
      const messages = body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        // Handler failure (status >= 400) → paymentWall skips settlement:
        // the caller is NOT charged for a request we could not serve
        // (scheme_exact.md "Payment Flow").
        res.status(400).json({ error: "messages must be a non-empty array" });
        return;
      }
      const lastUser = [...messages].reverse().find((m) => m?.role === "user");
      const prompt = typeof lastUser?.content === "string" ? lastUser.content : "";
      res.status(200).json({
        id: `chatcmpl-mock-${randomUUID()}`,
        object: "chat.completion",
        model: typeof body?.model === "string" ? body.model : "mock-llm",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `You said: ${prompt}` },
            finish_reason: "stop",
          },
        ],
      });
    },
  );

  // Read-only dashboard. No write path, no secrets: computeStatsFromLedger
  // returns a fixed whitelist of aggregate fields (src/dashboard.ts), and
  // amounts are rendered via BigInt-only formatAtomicDecimal.
  app.get("/dashboard", (_req, res) => {
    void (async () => {
      try {
        const stats = await computeStatsFromLedger(ledger);
        res.status(200).json({
          ...stats,
          totalSettledUsdc: formatAtomicDecimal(stats.totalSettledAtomic, 6),
          perPayer: stats.perPayer.map((p) => ({
            ...p,
            totalSettledUsdc: formatAtomicDecimal(p.totalSettledAtomic, 6),
          })),
        });
      } catch (e) {
        res.status(500).json({
          error: "ledger unreadable",
          detail: e instanceof Error ? e.message : "unknown",
        });
      }
    })();
  });

  return { app, ledger };
}
