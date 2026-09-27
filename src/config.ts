// Config resolution: unit-explicit pricing, registry-verified network/asset
// constants. Wire values are CAIP-2 only; human aliases never touch payloads.

import { AmountError, parsePriceToAtomic, type PriceInput } from "./amount.js";
import { X402_VERSION, type Network, type PaymentRequirements } from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface NetworkAssetInfo {
  /** CAIP-2 identifier — the ONLY value that goes on the wire (spec §11.1). */
  caip2: Network;
  /** Human-readable alias. NEVER used in protocol payloads. */
  alias: string;
  /** Native USDC contract address (6 decimals). */
  usdc: string;
  /** EIP-712 domain name of the USDC contract (scheme_exact_evm.md §1). */
  usdcDomainName: string;
  /** EIP-712 domain version of the USDC contract (scheme_exact_evm.md §1). */
  usdcDomainVersion: string;
}

/**
 * Verified network registry.
 *
 * USDC addresses verified 2026-09-27 against Circle's official USDC contract
 * addresses page: https://developers.circle.com/stablecoins/usdc-contract-addresses
 *   - Base (mainnet):    0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   - Base Sepolia:      0x036CbD53842c5426634e7929541eC2318f3dCF7e
 * The Base Sepolia address also appears in the x402 v2 spec examples
 * (specs/x402-specification-v2.md §5.1.1).
 * CAIP-2 identifiers verified against spec §11.1 and
 * @coinbase/cdp-sdk/x402 constants (baseMainnetCaip2 / baseSepoliaCaip2).
 * USDC EIP-712 domain name/version ("USDC"/"2") verified against
 * specs/schemes/exact/scheme_exact_evm.md §1 examples.
 */
export const NETWORKS = {
  "eip155:84532": {
    caip2: "eip155:84532",
    alias: "base-sepolia",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcDomainName: "USDC",
    usdcDomainVersion: "2",
  },
  "eip155:8453": {
    caip2: "eip155:8453",
    alias: "base-mainnet",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDomainName: "USDC",
    usdcDomainVersion: "2",
  },
} as const satisfies Record<string, NetworkAssetInfo>;

export type SupportedNetwork = keyof typeof NETWORKS;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface Pay402Config {
  /** Unit-explicit price: "$0.01" (USD, 6-decimal asset) or { amount: "10000", unit: "atomic" }. */
  price: PriceInput;
  /** CAIP-2 network id — wire format per spec §11.1. Only registry networks are accepted. */
  network: SupportedNetwork;
  /** Recipient wallet address (your address; funds settle directly to it — pay402 never custodies). */
  payTo: string;
  /** Token contract address. Defaults to native USDC for the network from the verified registry. */
  asset?: string;
  /** Payment scheme. Default and only currently supported scheme: "exact". */
  scheme?: "exact";
  /** Max seconds the client has to complete payment (spec §5.1.2). Default 60. */
  maxTimeoutSeconds?: number;
  /** Human-readable resource description advertised in the 402 challenge. */
  description?: string;
  /** Service name advertised in the 402 challenge (printable ASCII, ≤32 chars, spec §5.1.2). */
  serviceName?: string;
  /** Milliseconds to wait on facilitator verify/settle calls. Default 15000. */
  facilitatorTimeoutMs?: number;
}

export interface ResolvedConfig {
  requirements: PaymentRequirements;
  networkInfo: NetworkAssetInfo;
  priceAtomic: bigint;
  facilitatorTimeoutMs: number;
  description?: string;
  serviceName?: string;
}

/** Validate config and resolve it into spec-shaped PaymentRequirements. Throws ConfigError/AmountError. */
export function resolveConfig(config: Pay402Config): ResolvedConfig {
  const networkInfo: NetworkAssetInfo | undefined = NETWORKS[config.network];
  if (!networkInfo) {
    throw new ConfigError(
      `unsupported network ${JSON.stringify(config.network)}; wire format is CAIP-2, supported: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  if (typeof config.payTo !== "string" || !EVM_ADDRESS.test(config.payTo)) {
    throw new ConfigError(`payTo must be a 0x-prefixed 40-hex-char EVM address, got: ${JSON.stringify(config.payTo)}`);
  }
  const asset = config.asset ?? networkInfo.usdc;
  if (!EVM_ADDRESS.test(asset)) {
    throw new ConfigError(`asset must be a 0x-prefixed 40-hex-char address, got: ${JSON.stringify(asset)}`);
  }
  const scheme = config.scheme ?? "exact";
  if (scheme !== "exact") {
    throw new ConfigError(`unsupported scheme: ${JSON.stringify(scheme)}`);
  }
  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 60;
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new ConfigError(`maxTimeoutSeconds must be a positive integer, got: ${JSON.stringify(maxTimeoutSeconds)}`);
  }
  const facilitatorTimeoutMs = config.facilitatorTimeoutMs ?? 15_000;
  if (!Number.isInteger(facilitatorTimeoutMs) || facilitatorTimeoutMs <= 0) {
    throw new ConfigError(`facilitatorTimeoutMs must be a positive integer, got: ${JSON.stringify(facilitatorTimeoutMs)}`);
  }
  // USDC has 6 decimals on both Base networks (Circle docs, same source as addresses above).
  const USDC_DECIMALS = 6;
  let priceAtomic: bigint;
  try {
    priceAtomic = parsePriceToAtomic(config.price, USDC_DECIMALS);
  } catch (e) {
    if (e instanceof AmountError) {
      throw new ConfigError(`invalid price: ${e.message}`);
    }
    throw e;
  }
  if (config.serviceName !== undefined && (config.serviceName.length > 32 || !/^[\x20-\x7e]*$/.test(config.serviceName))) {
    throw new ConfigError(`serviceName must be printable ASCII, max 32 chars (spec §5.1.2)`);
  }

  const requirements: PaymentRequirements = {
    scheme,
    network: networkInfo.caip2,
    amount: priceAtomic.toString(),
    asset,
    payTo: config.payTo,
    maxTimeoutSeconds,
    // scheme_exact_evm.md §1: extra.name and extra.version are REQUIRED for
    // eip3009; assetTransferMethod defaults to "eip3009" when omitted but we
    // state it explicitly.
    extra: {
      assetTransferMethod: "eip3009",
      name: networkInfo.usdcDomainName,
      version: networkInfo.usdcDomainVersion,
    },
  };

  return {
    requirements,
    networkInfo,
    priceAtomic,
    facilitatorTimeoutMs,
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.serviceName !== undefined ? { serviceName: config.serviceName } : {}),
  };
}

export { X402_VERSION };
