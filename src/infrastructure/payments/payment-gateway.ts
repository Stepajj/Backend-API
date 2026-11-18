import Stripe from "stripe";

export interface CheckoutLineItem {
  name: string;
  unitAmount: number;
  quantity: number;
  currency: string;
}

export interface CheckoutSessionInput {
  orderId: string;
  idempotencyKey: string;
  lineItems: CheckoutLineItem[];
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSessionResult {
  id: string;
  url: string;
}

export interface PaymentGateway {
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult>;
  expireCheckoutSession(sessionId: string): Promise<void>;
}

export class PaymentGatewayError extends Error {
  constructor(message: string, readonly outcome: "not-created" | "unknown", options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentGatewayError";
  }
}

class StripePaymentGateway implements PaymentGateway {
  constructor(private readonly stripe: Stripe) {}

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    try {
      const session = await this.stripe.checkout.sessions.create({
        mode: "payment",
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        line_items: input.lineItems.map(item => ({
          quantity: item.quantity,
          price_data: {
            currency: item.currency,
            unit_amount: item.unitAmount,
            product_data: { name: item.name }
          }
        })),
        metadata: { orderId: input.orderId }
      }, { idempotencyKey: input.idempotencyKey });

      if (!session.url) throw new PaymentGatewayError("Stripe returned a Checkout Session without a URL", "unknown");
      return { id: session.id, url: session.url };
    } catch (error) {
      if (error instanceof PaymentGatewayError) throw error;
      const definitelyNotCreated = error instanceof Stripe.errors.StripeAuthenticationError || error instanceof Stripe.errors.StripeInvalidRequestError || error instanceof Stripe.errors.StripePermissionError;
      throw new PaymentGatewayError("Stripe Checkout Session request failed", definitelyNotCreated ? "not-created" : "unknown", { cause: error });
    }
  }

  async expireCheckoutSession(sessionId: string): Promise<void> {
    await this.stripe.checkout.sessions.expire(sessionId);
  }
}

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (stripeSecretKey && !stripeSecretKey.startsWith("sk_test_") && !stripeSecretKey.startsWith("sk_live_")) {
  throw new Error("STRIPE_SECRET_KEY must be a Stripe test or live secret key");
}
// Stripe's local HMAC verifier is an instance method; the fallback key is never used for API requests.
export const stripeWebhookVerifier = new Stripe(stripeSecretKey?.startsWith("sk_test_") ? stripeSecretKey : "sk_test_signature_verification_only");

const stripeModeAllowed = process.env.NODE_ENV !== "production" || stripeSecretKey?.startsWith("sk_live_");
export const paymentGateway: PaymentGateway | null = stripeModeAllowed && (stripeSecretKey?.startsWith("sk_test_") || stripeSecretKey?.startsWith("sk_live_")) && !stripeSecretKey.includes("replace_me")
    ? new StripePaymentGateway(new Stripe(stripeSecretKey))
    : null;
