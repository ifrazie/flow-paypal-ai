// Watches PayPal for invoice changes and broadcasts them to open Flow windows.
//
// Every few seconds it polls the cheap invoice list and compares statuses and balances
// with the last poll. Webhooks and Flow's own actions call requestCheck() to look right
// away. Either way, PayPal stays the only source of truth: nothing is marked paid unless
// PayPal says so.

import { EventEmitter } from "node:events";
import { amountOf, listInvoiceSummaries, type InvoiceSummary } from "./dashboard/paypal.js";
import { getDashboardData, type DashboardData } from "./dashboard/data.js";
import { buildTimeline, gatedPhase, type TimelineModel } from "./dashboard/projects.js";

export type ChangeKind = "paid" | "partial" | "refunded" | "cancelled" | "created" | "removed" | "updated";

export interface InvoiceChange {
  kind: ChangeKind;
  invoiceId: string;
  invoiceNumber: string;
  customer: string;
  currency: string;
  total: number;
  outstanding: number;
  /** For a payment: the phase it gates, and whether that phase is still blocked. */
  phase?: { name: string; blocked: boolean };
}

export interface FlowUpdate {
  changes: InvoiceChange[];
  dashboard: DashboardData;
  timeline: TimelineModel;
}

export const flowEvents = new EventEmitter();
flowEvents.setMaxListeners(100);

const PAID = new Set(["PAID", "MARKED_AS_PAID"]);
const REFUNDED = new Set(["REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED"]);

let seen: Map<string, InvoiceSummary> | null = null;
let running = false;
let again = false;
let soon: ReturnType<typeof setTimeout> | null = null;

function customerOf(inv: InvoiceSummary): string {
  const info = inv.primary_recipients?.[0]?.billing_info;
  return info?.business_name || info?.name?.full_name || info?.email_address || "A customer";
}

function kindOf(before: InvoiceSummary | undefined, after: InvoiceSummary): ChangeKind | null {
  if (!before) return "created";
  const dueChanged = amountOf(before.due_amount) !== amountOf(after.due_amount);
  if (before.status === after.status && !dueChanged) return null;
  if (PAID.has(after.status)) return "paid";
  if (after.status === "PARTIALLY_PAID") return "partial";
  if (REFUNDED.has(after.status)) return "refunded";
  if (after.status === "CANCELLED") return "cancelled";
  return "updated";
}

function toChange(kind: ChangeKind, inv: InvoiceSummary): InvoiceChange {
  return {
    kind,
    invoiceId: inv.id,
    invoiceNumber: inv.detail.invoice_number,
    customer: customerOf(inv),
    currency: inv.amount?.currency_code ?? inv.detail.currency_code,
    total: amountOf(inv.amount),
    outstanding: amountOf(inv.due_amount),
  };
}

async function check(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    const items = await listInvoiceSummaries();
    const next = new Map(items.map((i) => [i.id, i]));

    if (seen) {
      const changes: InvoiceChange[] = [];
      for (const inv of items) {
        const kind = kindOf(seen.get(inv.id), inv);
        if (kind) changes.push(toChange(kind, inv));
      }
      for (const [id, inv] of seen) {
        if (!next.has(id)) changes.push(toChange("removed", inv));
      }

      if (changes.length > 0) {
        const dashboard = await getDashboardData();
        const timeline = buildTimeline(dashboard);
        for (const c of changes) {
          if (c.kind === "paid" || c.kind === "partial") {
            const phase = gatedPhase(timeline, c.invoiceId);
            if (phase) c.phase = phase;
          }
        }
        const summary = changes.map((c) => `${c.kind} ${c.invoiceNumber}`).join(", ");
        console.log(`[watcher] ${summary}`);
        flowEvents.emit("update", { changes, dashboard, timeline } satisfies FlowUpdate);
      }
    }
    seen = next;
  } catch (err) {
    console.warn(`[watcher] check failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    running = false;
    if (again) {
      again = false;
      void check();
    }
  }
}

/** Look at PayPal right away (debounced), e.g. after a webhook or a payment Flow recorded. */
export function requestCheck(): void {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => {
    soon = null;
    void check();
  }, 400);
}

export function startPaymentWatcher(intervalMs = 15_000): void {
  void check();
  setInterval(() => void check(), intervalMs).unref();
  console.log(`  Watching PayPal for payments every ${Math.round(intervalMs / 1000)}s`);
}
