// In-repo mock facilitator implementing spec §7 (/verify, /settle semantics).
// For tests and local development only — deterministic, no network, no keys.

import type {
  FacilitatorClient,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "../types.js";

export interface MockFacilitatorOptions {
  /** Return isValid:false with this reason on verify. */
  rejectVerify?: string;
  /** Return success:false with this reason on settle. */
  rejectSettle?: string;
  /** Simulate a slow facilitator (ms) to exercise timeout handling. */
  latencyMs?: number;
  /** Payer address reported in responses. */
  payer?: string;
  /** Transaction hash reported on successful settle. */
  transaction?: string;
}

const DEFAULT_PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const DEFAULT_TX = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

export class MockFacilitator implements FacilitatorClient {
  readonly verifyCalls: Array<{ paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements }> = [];
  readonly settleCalls: Array<{ paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements }> = [];

  constructor(private options: MockFacilitatorOptions = {}) {}

  private async delay(): Promise<void> {
    const ms = this.options.latencyMs;
    if (ms !== undefined && ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.verifyCalls.push({ paymentPayload, paymentRequirements });
    await this.delay();
    if (this.options.rejectVerify !== undefined) {
      return {
        isValid: false,
        invalidReason: this.options.rejectVerify,
        payer: this.options.payer ?? DEFAULT_PAYER,
      };
    }
    return { isValid: true, payer: this.options.payer ?? DEFAULT_PAYER };
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.settleCalls.push({ paymentPayload, paymentRequirements });
    await this.delay();
    if (this.options.rejectSettle !== undefined) {
      return {
        success: false,
        errorReason: this.options.rejectSettle,
        payer: this.options.payer ?? DEFAULT_PAYER,
        transaction: "",
        network: paymentRequirements.network,
      };
    }
    return {
      success: true,
      payer: this.options.payer ?? DEFAULT_PAYER,
      transaction: this.options.transaction ?? DEFAULT_TX,
      network: paymentRequirements.network,
    };
  }
}
