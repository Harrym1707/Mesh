/**
 * A dependency-free Stripe REST client — the one place MESH talks to Stripe.
 *
 * Promoted from the form-encoded `stripePost` in scripts/mesh-bill so the
 * automated billing worker and the self-serve payment endpoints share one
 * hardened client instead of re-rolling fetch calls. Everything is
 * form-encoded, idempotency-keyed, and zero-dependency, matching the repo.
 *
 * SAFETY: the client refuses a live secret key (sk_live_…) unless `allowLive`
 * is passed explicitly. The automated signup/metering/billing paths NEVER pass
 * it, so no amount of configuration can make the unattended system charge real
 * money — live billing stays the deliberate, human-gated mesh-bill --live path.
 */

export type StripeMode = "test" | "live";

/** Nested form values (objects/arrays) flattened to Stripe's bracket notation. */
export type StripeForm = Record<string, string | number | boolean | undefined>;

export type StripeCustomer = { id: string };
export type StripeCheckoutSession = { id: string; url: string | null; status?: string };
export type StripeSetupIntent = { id: string; status: string; client_secret: string | null; payment_method: string | null };
export type StripeInvoiceItem = { id: string };
export type StripeInvoice = {
  id: string;
  status: string;
  amount_due?: number;
  hosted_invoice_url?: string | null;
  payment_intent?: string | null;
};
export type StripeRefund = { id: string; status: string };

/**
 * The operations the billing worker depends on. Narrow on purpose so the
 * worker can be unit-tested with a fake, and so the payment-choice branching is
 * exercised without a Stripe account.
 */
export interface BillingStripe {
  readonly mode: StripeMode;
  createInvoice(params: {
    customerId: string;
    currency: string;
    collectionMethod: "charge_automatically" | "send_invoice";
    description?: string;
    daysUntilDue?: number;
    defaultPaymentMethod?: string;
    autoAdvance?: boolean;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<StripeInvoice>;
  createInvoiceItem(params: {
    customerId: string;
    invoiceId: string;
    amountCents: number;
    currency: string;
    description: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<StripeInvoiceItem>;
  finalizeInvoice(invoiceId: string, idempotencyKey?: string): Promise<StripeInvoice>;
  payInvoice(invoiceId: string, idempotencyKey?: string): Promise<StripeInvoice>;
}

/** The fuller surface the payment-setup and admin endpoints use. */
export interface StripeClient extends BillingStripe {
  createCustomer(params: { email?: string; metadata?: Record<string, string>; idempotencyKey?: string }): Promise<StripeCustomer>;
  createMandateCheckoutSession(params: {
    customerId: string;
    paymentMethodTypes: string[];
    successUrl: string;
    cancelUrl: string;
    currency: string;
    idempotencyKey?: string;
  }): Promise<StripeCheckoutSession>;
  getCheckoutSession(sessionId: string): Promise<StripeCheckoutSession & { setup_intent: string | null; customer: string | null }>;
  getSetupIntent(setupIntentId: string): Promise<StripeSetupIntent>;
  setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
  createRefund(params: { paymentIntentId: string; amountCents?: number; idempotencyKey?: string }): Promise<StripeRefund>;
  getInvoice(invoiceId: string): Promise<StripeInvoice>;
}

function flatten(form: StripeForm, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined) continue;
    const name = prefix === "" ? key : `${prefix}[${key}]`;
    out[name] = String(value);
  }
  return out;
}

export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

/**
 * Create the real Stripe client. `allowLive` defaults to false: a live key is
 * refused unless the caller opts in deliberately (only the human-gated
 * mesh-bill path ever does).
 */
export function createStripeClient(
  secretKey: string,
  options: { allowLive?: boolean; fetch?: typeof fetch } = {},
): StripeClient {
  if (!secretKey) throw new Error("A Stripe secret key is required.");
  const mode: StripeMode = secretKey.startsWith("sk_live_") ? "live" : "test";
  if (mode === "live" && options.allowLive !== true) {
    throw new Error(
      "Refusing a LIVE Stripe key for the automated path. Self-serve signup and billing run " +
      "in TEST MODE only — use an sk_test_… key.",
    );
  }
  const doFetch = options.fetch ?? fetch;

  async function request<T>(method: "GET" | "POST", path: string, form?: StripeForm, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` };
    let url = `https://api.stripe.com/v1/${path}`;
    let body: string | undefined;
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form === undefined ? {} : flatten(form)).toString();
    } else if (form !== undefined) {
      url += `?${new URLSearchParams(flatten(form)).toString()}`;
    }
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await doFetch(url, { method, headers, ...(body === undefined ? {} : { body }) });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const error = json.error as { message?: string; type?: string; code?: string } | undefined;
      throw new StripeApiError(error?.message ?? `Stripe ${path} failed (${res.status})`, res.status, error?.type, error?.code);
    }
    return json as T;
  }

  return {
    mode,
    async createCustomer(params) {
      return request("POST", "customers", {
        ...(params.email === undefined ? {} : { email: params.email }),
        ...(params.metadata === undefined ? {} : flattenMetadata(params.metadata)),
      }, params.idempotencyKey);
    },
    async createMandateCheckoutSession(params) {
      const form: StripeForm = {
        mode: "setup",
        customer: params.customerId,
        currency: params.currency,
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
      };
      params.paymentMethodTypes.forEach((type, index) => {
        form[`payment_method_types[${index}]`] = type;
      });
      return request("POST", "checkout/sessions", form, params.idempotencyKey);
    },
    async getCheckoutSession(sessionId) {
      return request("GET", `checkout/sessions/${encodeURIComponent(sessionId)}`);
    },
    async getSetupIntent(setupIntentId) {
      return request("GET", `setup_intents/${encodeURIComponent(setupIntentId)}`);
    },
    async setDefaultPaymentMethod(customerId, paymentMethodId) {
      await request("POST", `customers/${encodeURIComponent(customerId)}`, {
        "invoice_settings[default_payment_method]": paymentMethodId,
      });
    },
    async createInvoice(params) {
      return request("POST", "invoices", {
        customer: params.customerId,
        currency: params.currency,
        collection_method: params.collectionMethod,
        auto_advance: params.autoAdvance === true,
        ...(params.description === undefined ? {} : { description: params.description }),
        ...(params.daysUntilDue === undefined ? {} : { days_until_due: params.daysUntilDue }),
        ...(params.defaultPaymentMethod === undefined ? {} : { default_payment_method: params.defaultPaymentMethod }),
        ...(params.metadata === undefined ? {} : flattenMetadata(params.metadata)),
      }, params.idempotencyKey);
    },
    async createInvoiceItem(params) {
      return request("POST", "invoiceitems", {
        customer: params.customerId,
        invoice: params.invoiceId,
        amount: params.amountCents,
        currency: params.currency,
        description: params.description,
        ...(params.metadata === undefined ? {} : flattenMetadata(params.metadata)),
      }, params.idempotencyKey);
    },
    async finalizeInvoice(invoiceId, idempotencyKey) {
      return request("POST", `invoices/${encodeURIComponent(invoiceId)}/finalize`, {}, idempotencyKey);
    },
    async payInvoice(invoiceId, idempotencyKey) {
      return request("POST", `invoices/${encodeURIComponent(invoiceId)}/pay`, {}, idempotencyKey);
    },
    async getInvoice(invoiceId) {
      return request("GET", `invoices/${encodeURIComponent(invoiceId)}`);
    },
    async createRefund(params) {
      return request("POST", "refunds", {
        payment_intent: params.paymentIntentId,
        ...(params.amountCents === undefined ? {} : { amount: params.amountCents }),
      }, params.idempotencyKey);
    },
  };
}

function flattenMetadata(metadata: Record<string, string>): StripeForm {
  const out: StripeForm = {};
  for (const [key, value] of Object.entries(metadata)) out[`metadata[${key}]`] = value;
  return out;
}
