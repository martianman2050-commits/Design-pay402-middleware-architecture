// CLI entry: pays one call to the mock LLM server end-to-end.
//
// DEMO PRIVATE KEY: Hardhat/Anvil test account #0 — published in the
// Hardhat docs (address 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
// key→address derivation verified locally with viem privateKeyToAccount).
// It holds nothing on any real network. NEVER put a funded key into an
// example; for production, give each agent its own wallet and fund it
// with testnet USDC from the Coinbase CDP faucet.
//
// Run: npm run example:agent [serverBaseUrl]

import { runAgent } from "./agent.js";

const DEMO_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

async function main(): Promise<void> {
  const baseUrl = process.argv[2] ?? process.env.PAY402_SERVER_URL ?? "http://127.0.0.1:4021";
  // For a real run: AGENT_PRIVATE_KEY from a secret manager / env — never
  // committed. Falls back to the published demo key (mock facilitator only).
  const envKey = process.env.AGENT_PRIVATE_KEY;
  const privateKey = (envKey ?? DEMO_PRIVATE_KEY) as `0x${string}`;
  console.log(`[agent] paying call to ${baseUrl} ...`);
  const result = await runAgent({ baseUrl, privateKey });
  console.log(`[agent] HTTP ${result.status} (payer ${result.payer})`);
  console.log(`[agent] body: ${JSON.stringify(result.body)}`);
  if (result.status !== 200) {
    process.exitCode = 1;
  }
}

void main();
