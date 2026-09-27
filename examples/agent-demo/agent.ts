// Reference x402-paying agent.
//
// Uses the OFFICIAL x402 client stack (verified against the installed type
// defs, all @x402/* v2.27.0):
//   - x402Client             from @x402/core/client
//   - registerExactEvmScheme from @x402/evm/exact/client
//   - wrapFetchWithPayment   from @x402/fetch
//   - privateKeyToAccount    from viem/accounts (local signer — the key
//                            never leaves this process; pay402 servers
//                            never see it either)
//
// wrapFetchWithPayment handles the 402 dance transparently: on a 402 it
// reads PAYMENT-REQUIRED, selects from `accepts`, signs an EIP-3009
// authorization locally, and retries with PAYMENT-SIGNATURE. Any agent
// framework that lets you supply a fetch implementation (Vercel AI SDK,
// LangChain, OpenAI SDK, ...) can be handed `payFetch` below and becomes
// x402-capable.

import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

export interface RunAgentOptions {
  /** Base URL of the pay402-wrapped server, e.g. "http://127.0.0.1:4021". */
  baseUrl: string;
  /** Demo-only EVM private key used to sign payment authorizations. */
  privateKey: `0x${string}`;
  /** Prompt for the mock LLM. */
  prompt?: string;
}

export interface AgentResult {
  status: number;
  body: unknown;
  /** Checksummed address that signed the payment. */
  payer: `0x${string}`;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const account = privateKeyToAccount(options.privateKey);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const payFetch = wrapFetchWithPayment(fetch, client);

  const res = await payFetch(`${options.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mock-llm",
      messages: [{ role: "user", content: options.prompt ?? "Hello, metered world!" }],
    }),
  });

  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body, payer: account.address };
}
