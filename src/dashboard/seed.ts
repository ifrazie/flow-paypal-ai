// Dev seed: creates a spread of USD sandbox invoices across several customers with
// varied past-due dates, so the receivables / aging widgets have realistic data to
// show. Invoices are sent (without emailing) so they become open, overdue receivables.
//
// Run with: npm run seed

import { resolvePaypalToken } from "../paypalAuth.js";

const BASE = "https://api-m.sandbox.paypal.com";

interface Customer {
  email: string;
  given: string;
  surname: string;
  business: string;
}

const CUSTOMERS: Customer[] = [
  { email: "flow-acme@personal.example.com", given: "Ava", surname: "Nguyen", business: "Acme Studio" },
  { email: "flow-globex@personal.example.com", given: "Liam", surname: "Patel", business: "Globex Media" },
  { email: "flow-initech@personal.example.com", given: "Mia", surname: "Rossi", business: "Initech LLC" },
  { email: "flow-umbrella@personal.example.com", given: "Noah", surname: "Kim", business: "Umbrella Co" },
  { email: "flow-soylent@personal.example.com", given: "Zoe", surname: "Haddad", business: "Soylent Corp" },
];

// [amount, invoice age in days, payment-term days]. Overdue when age > term.
const SPECS: [number, number, number][] = [
  [1200, 95, 15], // 80 days overdue  -> 90+ bucket (after more)
  [800, 72, 30], // 42 days overdue  -> 31-60
  [2500, 60, 15], // 45 days overdue  -> 31-60
  [450, 48, 30], // 18 days overdue  -> 1-30
  [3200, 40, 15], // 25 days overdue  -> 1-30
  [600, 120, 30], // 90 days overdue  -> 90+
  [1500, 20, 15], // 5 days overdue   -> 1-30
  [950, 12, 30], // not yet due
  [2100, 8, 30], // not yet due
  [1800, 100, 60], // 40 days overdue -> 31-60
  [1350, 78, 15], // 63 days overdue -> 61-90
  [700, 66, 15], // 51 days overdue -> 31-60
];

const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const isoPlus = (date: string, days: number) =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const token = await resolvePaypalToken();
  if (!token) throw new Error("No PayPal credentials configured (PAYPAL_CLIENT_ID/PAYPAL_SECRET).");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const stamp = Date.now() % 100000;

  let created = 0;
  let sent = 0;

  for (let i = 0; i < SPECS.length; i++) {
    const [amount, ageDays, termDays] = SPECS[i]!;
    const cust = CUSTOMERS[i % CUSTOMERS.length]!;
    const invoiceDate = isoDaysAgo(ageDays);
    const dueDate = isoPlus(invoiceDate, termDays);

    const body = {
      detail: {
        invoice_number: `FLOW-${stamp}-${i}`,
        currency_code: "USD",
        invoice_date: invoiceDate,
        payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: dueDate },
        note: "Thanks for your business!",
      },
      primary_recipients: [
        {
          billing_info: {
            email_address: cust.email,
            name: { given_name: cust.given, surname: cust.surname },
            business_name: cust.business,
          },
        },
      ],
      items: [
        {
          name: "Consulting services",
          quantity: "1",
          unit_amount: { currency_code: "USD", value: amount.toFixed(2) },
        },
      ],
    };

    const createRes = await fetch(`${BASE}/v2/invoicing/invoices`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!createRes.ok) {
      console.warn(`  create #${i} failed ${createRes.status}: ${(await createRes.text()).slice(0, 180)}`);
      continue;
    }
    created++;
    const loc = (await createRes.json()) as { href?: string };
    const id = loc.href?.split("/").pop();
    if (!id) {
      console.warn(`  create #${i}: no invoice id in response`);
      continue;
    }

    const sendRes = await fetch(`${BASE}/v2/invoicing/invoices/${id}/send`, {
      method: "POST",
      headers,
      body: JSON.stringify({ send_to_recipient: false }),
    });
    if (sendRes.ok) {
      sent++;
      console.log(`  ${cust.business}: $${amount} invoiced ${invoiceDate}, due ${dueDate} → sent (${id})`);
    } else {
      console.warn(`  send ${id} failed ${sendRes.status}: ${(await sendRes.text()).slice(0, 180)}`);
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\nSeed complete: created ${created}, sent ${sent}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
