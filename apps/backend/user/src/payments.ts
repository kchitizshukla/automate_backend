// ──────────────────────────────────────────────
// Payment gateway abstraction for roadside jobs.
//
// The route layer only ever talks to `paymentGateway`. Swapping the POC
// simulator for Razorpay/Stripe/Paytm means writing another object that
// satisfies PaymentGateway and changing the one export at the bottom — no
// route, no component and no database column has to move.
// ──────────────────────────────────────────────
import type { PaymentMethod } from '@automate/shared-types';

export interface PaymentIntent {
  /** Gateway-side handle. Real providers return their own order/intent id. */
  reference: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
}

export interface PaymentOutcome {
  success: boolean;
  transactionId: string | null;
  failureReason?: string;
}

export interface PaymentGateway {
  readonly name: string;
  /** Step 1: register the intent to pay. */
  initiateOnlinePayment(input: { requestId: number; amount: number; currency: string }): Promise<PaymentIntent>;
  /** Step 2: capture. Real gateways do this via a redirect/webhook. */
  processOnlinePayment(intent: PaymentIntent): Promise<PaymentOutcome>;
  /** Cash never touches a gateway — it only records the customer's choice. */
  selectCashPayment(input: { requestId: number; amount: number }): Promise<PaymentIntent>;
}

export const PAYMENT_CONFIG = {
  currency: 'INR',
  /** Simulated network latency so the UI's processing state is real. */
  simulatedLatencyMs: Number(process.env.PAYMENT_SIMULATED_LATENCY_MS) || 1400,
  /**
   * Probability (0..1) that a simulated online payment fails, so the failure
   * and retry paths can actually be exercised. 0 disables failures.
   */
  simulatedFailureRate: Number(process.env.PAYMENT_SIMULATED_FAILURE_RATE) || 0,
} as const;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reference ids are minted here, never in the UI and never hardcoded. */
function mintReference(prefix: string, requestId: number): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${requestId}-${Date.now().toString().slice(-6)}${rand}`;
}

/**
 * POC gateway. Deliberately stores nothing card-shaped: there is no card
 * form, no PAN, no CVV — a simulated capture and a generated reference only.
 */
export const simulatedGateway: PaymentGateway = {
  name: 'simulated',

  async initiateOnlinePayment({ requestId, amount, currency }) {
    return {
      reference: mintReference('ORD', requestId),
      amount,
      currency,
      method: 'ONLINE',
    };
  },

  async processOnlinePayment(intent) {
    await wait(PAYMENT_CONFIG.simulatedLatencyMs);

    if (PAYMENT_CONFIG.simulatedFailureRate > 0 && Math.random() < PAYMENT_CONFIG.simulatedFailureRate) {
      return {
        success: false,
        transactionId: null,
        failureReason: 'The payment was declined by the issuing bank. Please try again.',
      };
    }

    return {
      success: true,
      transactionId: intent.reference.replace(/^ORD/, 'TXN'),
    };
  },

  async selectCashPayment({ requestId, amount }) {
    return {
      reference: mintReference('CASH', requestId),
      amount,
      currency: PAYMENT_CONFIG.currency,
      method: 'CASH',
    };
  },
};

/** The single binding the routes import. Point this at a real provider later. */
export const paymentGateway: PaymentGateway = simulatedGateway;


