// Registers Flow's webhook with PayPal so invoice payments reach the app instantly.
// The app must be reachable over HTTPS (e.g. the Render deploy); PayPal can't call localhost.
//
// Usage: npm run webhook:register -- https://your-app.onrender.com
// Then set the printed PAYPAL_WEBHOOK_ID on the server so deliveries are signature-checked.

import { config } from "../config.js";
import { resolvePaypalToken } from "../paypalAuth.js";

const EVENT_TYPES = [
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.UPDATED",
  "INVOICING.INVOICE.REFUNDED",
  "INVOICING.INVOICE.CANCELLED",
  "INVOICING.INVOICE.SENT",
  "INVOICING.INVOICE.CREATED",
  "INVOICING.INVOICE.UNPAID",
];

async function main(): Promise<void> {
  const base = process.argv[2]?.replace(/\/+$/, "");
  if (!base || !base.startsWith("https://")) {
    throw new Error("Usage: npm run webhook:register -- https://your-app.example.com (HTTPS required)");
  }
  const url = `${base}/api/webhooks/paypal`;

  const token = await resolvePaypalToken();
  if (!token) throw new Error("No PayPal credentials configured (PAYPAL_CLIENT_ID/PAYPAL_SECRET).");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const res = await fetch(`${config.paypal.apiBase}/v1/notifications/webhooks`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url, event_types: EVENT_TYPES.map((name) => ({ name })) }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };

  let id = body.id;
  if (!res.ok && body.name === "WEBHOOK_URL_ALREADY_EXISTS") {
    const list = await fetch(`${config.paypal.apiBase}/v1/notifications/webhooks`, { headers });
    const existing = ((await list.json()) as { webhooks?: { id: string; url: string }[] }).webhooks ?? [];
    id = existing.find((w) => w.url === url)?.id;
    console.log("A webhook for this URL already exists.");
  } else if (!res.ok) {
    throw new Error(`PayPal ${res.status}: ${body.message ?? JSON.stringify(body)}`);
  }

  console.log(`Webhook: ${url}`);
  console.log(`Events:  ${EVENT_TYPES.join(", ")}`);
  console.log(`\nSet this on the server to enable signature checks:\nPAYPAL_WEBHOOK_ID=${id}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
