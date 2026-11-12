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

/** Refuse stale reminders when PayPal now reports no amount due. */
export async function assertInvoiceHasBalance(invoiceId: string): Promise<void> {
  const detail = await paypal("GET", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
  if (!detail.ok) throw new Error(`PayPal invoice lookup failed (${detail.status}).`);
  const status = detail.json?.status;
  const amount = Number(detail.json?.due_amount?.value);
  if (!Number.isFinite(amount) || amount <= 0 || !["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"].includes(status)) {
    throw new Error("Invoice is no longer unpaid. Refresh before sending a reminder.");
  }
}

/**
 * Records a payment for an invoice's full outstanding balance in PayPal, as if the customer
 * had paid outside PayPal (PayPal marks it MARKED_AS_PAID). This changes PayPal's own record,
 * so Flow picks it up through the same path as a real customer payment.
 */
export async function recordInvoicePayment(
  invoiceId: string,
  expected: { amount: string; currency: string },
): Promise<{ paymentId?: string; amount: string; currency: string }> {
  const id = encodeURIComponent(invoiceId);
  const detail = await paypal("GET", `/v2/invoicing/invoices/${id}`);
  if (!detail.ok) throw new Error(`PayPal ${detail.status}: ${detail.text.slice(0, 200)}`);

  const due = detail.json?.due_amount;
  if (!due?.value || Number(due.value) <= 0) throw new Error("This invoice has no outstanding balance.");
  if (!Number.isFinite(Number(due.value)) || Number(due.value).toFixed(2) !== expected.amount ||
      due.currency_code !== expected.currency) {
    throw new Error("The outstanding balance changed. Refresh and approve the updated amount.");
  }

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
  if (["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"].some((name) => !header(name))) {
    return false;
  }
  const res = await paypal("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: header("paypal-auth-algo"),
    cert_url: header("paypal-cert-url"),
    transmission_id: header("paypal-transmission-id"),
    transmission_sig: header("paypal-transmission-sig"),
    transmission_time: header("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: event,
  });
  if (!res.ok) throw new Error(`PayPal verification unavailable (${res.status}).`);
  return res.json?.verification_status === "SUCCESS";
}
