// PayPal invoice actions Flow takes on the user's behalf, plus webhook signature checks.

import type { IncomingHttpHeaders } from "node:http";
import { config } from "./config.js";
import { resolvePaypalToken } from "./paypalAuth.js";

async function paypal(method: string, path: string, body?: unknown) {
  const token = await resolvePaypalToken();
  if (!token) throw new Error("PayPal is not configured (set PAYPAL_CLIENT_ID and PAYPAL_SECRET).");
  const res = await fetch(`${config.paypal.apiBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Records a payment for an invoice's full outstanding balance in PayPal, as if the customer
 * had paid outside PayPal (PayPal marks it MARKED_AS_PAID). This changes PayPal's own record,
 * so Flow picks it up through the same path as a real customer payment.
 */
export async function recordInvoicePayment(invoiceId: string): Promise<{ paymentId?: string; amount: string; currency: string }> {
  const id = encodeURIComponent(invoiceId);
  const detail = await paypal("GET", `/v2/invoicing/invoices/${id}`);
  if (!detail.ok) throw new Error(`PayPal ${detail.status}: ${detail.text.slice(0, 200)}`);

  const due = detail.json?.due_amount;
  if (!due?.value || Number(due.value) <= 0) throw new Error("This invoice has no outstanding balance.");

  const pay = await paypal("POST", `/v2/invoicing/invoices/${id}/payments`, {
    method: "OTHER",
    payment_date: new Date().toISOString().slice(0, 10),
    amount: { currency_code: due.currency_code, value: due.value },
    note: "Payment recorded in Flow",
  });
  if (!pay.ok) throw new Error(`PayPal ${pay.status}: ${pay.text.slice(0, 200)}`);
  return { paymentId: pay.json?.payment_id, amount: due.value, currency: due.currency_code };
}

/** Asks PayPal whether a webhook delivery really came from PayPal for our webhook. */
export async function verifyWebhookSignature(
  headers: IncomingHttpHeaders,
  event: unknown,
  webhookId: string,
): Promise<boolean> {
  const header = (name: string) => String(headers[name] ?? "");
  const res = await paypal("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: header("paypal-auth-algo"),
    cert_url: header("paypal-cert-url"),
    transmission_id: header("paypal-transmission-id"),
    transmission_sig: header("paypal-transmission-sig"),
    transmission_time: header("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: event,
  });
  return res.ok && res.json?.verification_status === "SUCCESS";
}
