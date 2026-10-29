// Dev seed: resets Flow's demo data in the PayPal sandbox, then creates client invoices for
// the sandbox customer accounts listed in seed-emails.md. Invoices are sent with PayPal
// notifications, so each customer can sign in to the sandbox and pay them.
//
// seed-emails.md (gitignored) has one customer per line:
//   email                          or
//   email | Business name | Contact name
//
// Run with: npm run seed            (npm run seed -- --check lists the customers and stops)
// Safe to re-run: earlier FLOW- invoices are cleared first. An invoice a customer actually
// paid through PayPal can't be cancelled, so it stays as payment history.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePaypalToken } from "../paypalAuth.js";

const BASE = "https://api-m.sandbox.paypal.com";
const PREFIX = "FLOW-";
const DAY_MS = 86_400_000;

type Method = "BANK_TRANSFER" | "CHECK" | "WIRE_TRANSFER";

interface Tranche {
  /** Line item; also the phase name on the delivery timeline. */
  item: string;
  amount: number;
  invoicedDaysAgo: number;
  /** Days from the invoice date to the due date. */
  termDays: number;
  /** A payment already received, recorded against the invoice. Less than `amount` is partial. */
  paid?: { daysAgo: number; method: Method; amount?: number };
  /** The tranche to pay live during the demo; its payment link is printed at the end. */
  demo?: boolean;
}

interface Story {
  summary: string;
  tranches: Tranche[];
}

interface Customer {
  email: string;
  business: string;
  given: string;
  surname: string;
}

// One story per customer, in the order the emails appear in seed-emails.md. Together they
// cover every aging bucket (1-30, 31-60, 61-90, 90+) and every timeline state.
const STORIES: Story[] = [
  {
    summary: "an overdue tranche blocks the next phase — pay it live in the demo",
    tranches: [
      { item: "Discovery & design", amount: 2400, invoicedDaysAgo: 110, termDays: 30, paid: { daysAgo: 82, method: "BANK_TRANSFER" } },
      { item: "Build & integration", amount: 3600, invoicedDaysAgo: 63, termDays: 30, demo: true },
      { item: "Launch & handoff", amount: 3000, invoicedDaysAgo: 20, termDays: 30 },
    ],
  },
  {
    summary: "a healthy client who pays on time",
    tranches: [
      { item: "Brand strategy", amount: 1800, invoicedDaysAgo: 90, termDays: 15, paid: { daysAgo: 80, method: "CHECK" } },
      { item: "Campaign production", amount: 4200, invoicedDaysAgo: 70, termDays: 30, paid: { daysAgo: 45, method: "BANK_TRANSFER" } },
      { item: "Analytics retainer", amount: 1500, invoicedDaysAgo: 35, termDays: 45 },
    ],
  },
  {
    summary: "badly behind: both tranches unpaid",
    tranches: [
      { item: "Content audit", amount: 1200, invoicedDaysAgo: 125, termDays: 30 },
      { item: "Site rebuild", amount: 5200, invoicedDaysAgo: 92, termDays: 30 },
    ],
  },
  {
    summary: "a partial payment keeps the next phase blocked",
    tranches: [
      { item: "Security assessment", amount: 2000, invoicedDaysAgo: 80, termDays: 15, paid: { daysAgo: 66, method: "WIRE_TRANSFER" } },
      { item: "Remediation sprint", amount: 4000, invoicedDaysAgo: 57, termDays: 45, paid: { daysAgo: 20, method: "BANK_TRANSFER", amount: 1500 } },
      { item: "Compliance report", amount: 1800, invoicedDaysAgo: 10, termDays: 30 },
    ],
  },
  {
    summary: "a new engagement, nothing due yet",
    tranches: [{ item: "Kickoff & roadmap", amount: 2800, invoicedDaysAgo: 3, termDays: 30 }],
  },
];

// --- helpers -------------------------------------------------------------------------

const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
const isoPlus = (date: string, days: number) =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Readable fallback from an email's local part, e.g. "globex.media@…" → "Globex Media".
function fromLocalPart(email: string): Pick<Customer, "business" | "given" | "surname"> {
  const local = email.split("@")[0]!.toLowerCase();
  const words = local.split(/[._-]+/).filter(Boolean);
  const business = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") || local;
  return { business, given: words[0] ? business : local, surname: "" };
}

function readCustomers(): Customer[] {
  const file = resolve(process.cwd(), "seed-emails.md");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Missing ${file}: list one sandbox customer email per line.`);
  }
  const customers = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter((line) => line.includes("@") && !line.startsWith("#"))
    .map((line): Customer => {
      const [email = "", business, contact] = line.split("|").map((part) => part.trim());
      const fallback = fromLocalPart(email);
      const [given, ...rest] = (contact ?? "").split(/\s+/).filter(Boolean);
      return {
        email,
        business: business || fallback.business,
        given: given ?? fallback.given,
        surname: given ? rest.join(" ") : fallback.surname,
      };
    });
  if (customers.length === 0) throw new Error(`No emails found in ${file}.`);
  return customers;
}

let token = "";

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
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

async function listAllInvoices(): Promise<any[]> {
  const items: any[] = [];
  for (let page = 1; ; page++) {
    const res = await api("GET", `/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true`);
    if (!res.ok) throw new Error(`List invoices failed ${res.status}: ${res.text.slice(0, 200)}`);
    items.push(...(res.json?.items ?? []));
    if (page >= (res.json?.total_pages ?? 1)) return items;
  }
}

// --- reset ---------------------------------------------------------------------------

async function clearPrevious(): Promise<void> {
  const ours = (await listAllInvoices()).filter(
    (i) => String(i.detail?.invoice_number ?? "").startsWith(PREFIX) && i.status !== "CANCELLED",
  );
  let cleared = 0;
  const kept: string[] = [];

  for (const inv of ours) {
    const number = inv.detail.invoice_number as string;
    if (inv.status === "DRAFT" || inv.status === "SCHEDULED") {
      const res = await api("DELETE", `/v2/invoicing/invoices/${inv.id}`);
      res.ok ? cleared++ : kept.push(`${number} (delete ${res.status})`);
      continue;
    }
    if (inv.status === "PAID") {
      kept.push(`${number} (paid through PayPal)`);
      continue;
    }
    if (inv.status === "MARKED_AS_PAID" || inv.status === "PARTIALLY_PAID") {
      // Payments recorded outside PayPal can be removed, which lets the invoice be cancelled.
      const detail = await api("GET", `/v2/invoicing/invoices/${inv.id}`);
      for (const t of detail.json?.payments?.transactions ?? []) {
        const external = t.type ? t.type === "EXTERNAL" : t.method !== "PAYPAL";
        if (t.payment_id && external) {
          await api("DELETE", `/v2/invoicing/invoices/${inv.id}/payments/${t.payment_id}`);
        }
      }
    }
    const res = await api("POST", `/v2/invoicing/invoices/${inv.id}/cancel`, {
      send_to_recipient: false,
      send_to_invoicer: false,
    });
    res.ok ? cleared++ : kept.push(`${number} (cancel ${res.status})`);
    await pause(150);
  }

  console.log(`Cleared ${cleared} earlier Flow invoice(s).`);
  if (kept.length) console.log(`Kept: ${kept.join(", ")}`);
}

// --- seed ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const customers = readCustomers();

  if (process.argv.includes("--check")) {
    for (const [index, c] of customers.entries()) {
      const story = STORIES[index % STORIES.length]!;
      console.log(`${c.business} (${c.given} ${c.surname}`.trimEnd() + `) <${c.email}> — ${story.summary}`);
    }
    return;
  }

  const resolved = await resolvePaypalToken();
  if (!resolved) throw new Error("No PayPal credentials configured (PAYPAL_CLIENT_ID/PAYPAL_SECRET).");
  token = resolved;

  await clearPrevious();

  const run = Date.now().toString(36).slice(-4).toUpperCase();
  let sent = 0;
  let demoLink: { who: string; email: string; url: string } | null = null;

  for (const [index, profile] of customers.entries()) {
    const story = STORIES[index % STORIES.length]!;
    const email = profile.email;
    const code = profile.business.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
    console.log(`\n${profile.business} <${email}> — ${story.summary}`);

    for (const [n, t] of story.tranches.entries()) {
      const invoiceNumber = `${PREFIX}${code}-${n + 1}-${run}`;
      const invoiceDate = isoDaysAgo(t.invoicedDaysAgo);
      const dueDate = isoPlus(invoiceDate, t.termDays);

      const created = await api("POST", "/v2/invoicing/invoices", {
        detail: {
          invoice_number: invoiceNumber,
          currency_code: "USD",
          invoice_date: invoiceDate,
          payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: dueDate },
          note: "Thanks for your business!",
        },
        primary_recipients: [
          {
            billing_info: {
              email_address: email,
              name: { given_name: profile.given, surname: profile.surname },
              business_name: profile.business,
            },
          },
        ],
        items: [
          {
            name: t.item,
            quantity: "1",
            unit_amount: { currency_code: "USD", value: t.amount.toFixed(2) },
          },
        ],
      });
      const id = String(created.json?.href ?? "").split("/").pop();
      if (!created.ok || !id) {
        console.warn(`  ✗ ${t.item}: create failed ${created.status} ${created.text.slice(0, 160)}`);
        continue;
      }

      const send = await api("POST", `/v2/invoicing/invoices/${id}/send`, {
        subject: `${profile.business}: invoice ${invoiceNumber} for ${t.item}`,
        send_to_recipient: true,
        send_to_invoicer: false,
      });
      if (!send.ok) {
        console.warn(`  ✗ ${t.item}: send failed ${send.status} ${send.text.slice(0, 160)}`);
        continue;
      }
      sent++;

      let note = "";
      if (t.paid) {
        const amount = t.paid.amount ?? t.amount;
        const pay = await api("POST", `/v2/invoicing/invoices/${id}/payments`, {
          method: t.paid.method,
          payment_date: isoDaysAgo(t.paid.daysAgo),
          amount: { currency_code: "USD", value: amount.toFixed(2) },
          note: "Payment received",
        });
        note = pay.ok
          ? amount < t.amount
            ? ` · partially paid ${usd(amount)}`
            : " · paid"
          : ` · payment record failed ${pay.status}`;
      }

      if (t.demo) {
        const detail = await api("GET", `/v2/invoicing/invoices/${id}`);
        const url = detail.json?.detail?.metadata?.recipient_view_url;
        if (url) demoLink = { who: profile.business, email, url };
      }

      console.log(`  ✓ ${invoiceNumber}  ${t.item}  ${usd(t.amount)}  due ${dueDate}  ✉ sent${note}`);
      await pause(250);
    }
  }

  console.log(`\nSeed complete: ${sent} invoice(s) sent to ${customers.length} customer(s).`);
  if (demoLink) {
    console.log(`\nLive-payment demo: sign in to the PayPal sandbox as ${demoLink.email} and pay`);
    console.log(`${demoLink.who}'s overdue invoice here: ${demoLink.url}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
