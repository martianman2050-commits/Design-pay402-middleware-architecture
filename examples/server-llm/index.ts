// Boot script for the mock-LLM example server.
//
// Facilitator selection:
// - With CDP_API_KEY_ID + CDP_API_KEY_SECRET in the environment: uses the
//   Coinbase CDP hosted facilitator (real settlement; pay402 never holds
//   keys — the facilitator verifies/settles and funds go straight to payTo).
// - Otherwise: MockFacilitator (offline, accepts every payment — local
//   development and the e2e test only. NEVER point real funds at it.)
//
// Run: npm run example:server    (then, in another shell: npm run example:agent)

import { createCdpFacilitator, MockFacilitator, type FacilitatorClient } from "../../src/index.js";
import { createLlmServer, DEFAULT_LLM_CONFIG, DEMO_PAY_TO } from "./app.js";
import type { Pay402Config } from "../../src/index.js";

async function main(): Promise<void> {
  const hasCdpKeys = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
  let facilitator: FacilitatorClient;
  if (hasCdpKeys) {
    facilitator = await createCdpFacilitator();
    console.log("[pay402-example] facilitator: Coinbase CDP (hosted)");
  } else {
    facilitator = new MockFacilitator();
    console.log("[pay402-example] facilitator: MOCK (offline, accepts everything — not for production)");
  }

  // Funds settle directly to payTo — pay402 never custodies. Override the
  // demo address with PAY402_PAY_TO (validated by resolveConfig at startup).
  const config: Pay402Config = {
    ...DEFAULT_LLM_CONFIG,
    payTo: process.env.PAY402_PAY_TO ?? DEMO_PAY_TO,
  };
  const ledgerPath = process.env.PAY402_LEDGER ?? "examples/server-llm/ledger.jsonl";
  const port = process.env.PORT ?? "4021";
  const { app } = createLlmServer({ facilitator, ledgerPath, config });

  app.listen(port, () => {
    console.log(`[pay402-example] mock LLM server on http://127.0.0.1:${port}`);
    console.log(`[pay402-example] price: ${config.price} per POST /v1/chat/completions on ${config.network}`);
    console.log(`[pay402-example] payTo:  ${config.payTo}`);
    console.log(`[pay402-example] ledger:   ${ledgerPath}`);
    console.log(`[pay402-example] dashboard: http://127.0.0.1:${port}/dashboard`);
  });
}

void main();
