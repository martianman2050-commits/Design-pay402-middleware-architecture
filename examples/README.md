# pay402 examples

A metered mock-LLM API and a reference agent that pays it end-to-end using the
official x402 client stack (`@x402/core`, `@x402/evm`, `@x402/fetch`, viem).

## Run the offline demo (no keys, no funds, no network)

```sh
npm run example:server   # shell 1: mock LLM on http://127.0.0.1:4021
npm run example:agent    # shell 2: pays one request end-to-end
```

Then inspect the read-only revenue view:

```sh
curl http://127.0.0.1:4021/dashboard
```

Expected agent output (payer = Hardhat/Anvil test account #0, published in
Hardhat docs — it holds nothing anywhere):

```
[agent] HTTP 200 (payer 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266)
[agent] body: {"id":"chatcmpl-mock-...","choices":[{"message":{"content":"You said: Hello, metered world!"},...}]}
```

## Running against the real Coinbase CDP facilitator (Base Sepolia)

1. Get API keys at https://portal.cdp.coinbase.com/ and fund the agent wallet
   with testnet USDC from the CDP faucet.
2. Export `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` — `examples/server-llm/index.ts`
   then switches from the mock to the hosted CDP facilitator automatically.
3. Export `PAY402_PAY_TO=<your address>` — funds settle directly to it;
   pay402 never custodies. (Defaults to a demo address that holds nothing.)
4. Give the agent a funded testnet key (env var / secret manager — never commit it).

## Honest caveats

- **MockFacilitator reports a static payer** (`DEFAULT_PAYER` in
  `src/facilitator/mock.ts`), so ledger/dashboard payer fields under the mock
  do NOT reflect the signing wallet. The real signer IS asserted in
  `test/e2e.test.ts` via the EIP-3009 `authorization.from` in the payment
  payload. A real facilitator (CDP) derives the payer from the payload.
- The "LLM" is a deterministic echo. The point is the payment plumbing.
- The demo private key in `agent-demo/index.ts` is a published test account.
  NEVER put a funded key in an example.
- Any agent framework that accepts a custom `fetch` (Vercel AI SDK, LangChain,
  OpenAI SDK) can be handed the `payFetch` from `agent-demo/agent.ts` and
  becomes x402-capable.
