import { resolvePaypalToken } from "./paypalAuth.js";

const SANDBOX_API = "https://api-m.sandbox.paypal.com";

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  recipient: string;
  amount: number;
  currency: string;
  status: string;
  date: string;
}

/**
 * Lists invoices from the PayPal sandbox Invoicing API and normalizes them into
 * flat rows for the dashboard grid. Returns an empty list when PayPal isn't
 * configured. Throws on an API/auth error so the caller can surface it.
 */
export async function listInvoices(): Promise<InvoiceRow[]> {
  const token = await resolvePaypalToken();
  if (!token) return [];

  const res = await fetch(
    `${SANDBOX_API}/v2/invoicing/invoices?page_size=100&total_required=true`,
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PayPal invoices ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { items?: PaypalInvoice[] };
  return (data.items ?? []).map(normalize);
}

interface PaypalInvoice {
  id?: string;
  status?: string;
  detail?: { invoice_number?: string; invoice_date?: string; currency_code?: string };
  amount?: { currency_code?: string; value?: string };
  primary_recipients?: Array<{
    billing_info?: { email_address?: string; name?: { full_name?: string; given_name?: string } };
  }>;
}

function normalize(inv: PaypalInvoice): InvoiceRow {
  const billing = inv.primary_recipients?.[0]?.billing_info;
  const recipient =
    billing?.name?.full_name || billing?.name?.given_name || billing?.email_address || "—";
  return {
    id: inv.id ?? "",
    invoiceNumber: inv.detail?.invoice_number ?? "—",
    recipient,
    amount: Number(inv.amount?.value ?? 0),
    currency: inv.amount?.currency_code ?? inv.detail?.currency_code ?? "USD",
    status: inv.status ?? "UNKNOWN",
    date: inv.detail?.invoice_date ?? "",
  };
}

// Re-exported for callers that only need the sandbox base URL.
export const PAYPAL_SANDBOX_API = SANDBOX_API;
