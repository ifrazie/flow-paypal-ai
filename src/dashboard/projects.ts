// Builds a client-delivery timeline (Bryntum Gantt data) from PayPal invoices:
// each client is a project, each invoice a payment tranche, and each work phase
// is gated by the previous tranche. A tranche that is past due and not fully paid
// blocks the next phase — the heart of the "money gates the work" story.

import type { DashboardData } from "./data.js";

export type PaymentStatus = "paid" | "partial" | "overdue" | "pending";

export interface GanttTask {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  duration?: number;
  manuallyScheduled?: boolean;
  expanded?: boolean;
  parentId?: string;
  milestone?: boolean;
  percentDone?: number;
  cls?: string;
  eventColor?: string;
  // Custom fields surfaced in columns, actions and payment updates.
  customer?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  amount?: number;
  outstanding?: number;
  currency?: string;
  paymentStatus?: PaymentStatus;
  payerUrl?: string | null;
  blocked?: boolean;
}

export interface GanttDependency {
  id: string;
  from: string;
  to: string;
  /** 2 = finish-to-start */
  type?: number;
}

export interface TimelineModel {
  tasks: GanttTask[];
  dependencies: GanttDependency[];
}

type InvoiceRow = DashboardData["invoices"][number];

const COLOR: Record<PaymentStatus, string> = {
  paid: "green",
  partial: "orange",
  overdue: "red",
  pending: "blue",
};

// Not sent yet, so not a tranche the customer can pay.
const UNISSUED_GROUPS = new Set(["Draft", "Scheduled", "Cancelled"]);

const DAY_MS = 86_400_000;

function paymentStatus(inv: InvoiceRow): PaymentStatus {
  if (inv.statusGroup === "Paid") return "paid";
  if (inv.statusGroup === "Partially paid") return "partial";
  if (inv.overdueAmount > 0) return "overdue";
  return "pending";
}

const pastDueAndUnpaid = (inv: InvoiceRow) => inv.overdueAmount > 0;

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${Math.round(value)}`;
  }
}

/** Share of a phase's dates already elapsed, for phases still waiting on their tranche. */
function elapsedPercent(start: string, end: string, today: number): number {
  const from = Date.parse(start);
  const to = Date.parse(end) + DAY_MS;
  if (!(to > from)) return 0;
  return Math.round(Math.min(1, Math.max(0, (today - from) / (to - from))) * 100);
}

export function buildTimeline(data: DashboardData): TimelineModel {
  const tasks: GanttTask[] = [];
  const dependencies: GanttDependency[] = [];
  let depId = 1;
  const today = Date.parse(data.asOf);

  const clientName = new Map<string, string>();
  for (const c of data.customers) {
    const company = c.company && c.company !== "Individual" ? c.company : null;
    clientName.set(c.id, company ?? c.name ?? c.id);
  }

  // The first line item names the phase the tranche pays for.
  const phaseName = new Map<string, string>();
  for (const item of data.invoiceItems) {
    if (!phaseName.has(item.invoiceId)) phaseName.set(item.invoiceId, item.name);
  }

  const byCustomer = new Map<string, InvoiceRow[]>();
  for (const inv of data.invoices) {
    if (!inv.invoiceDate || !inv.dueDate || UNISSUED_GROUPS.has(inv.statusGroup)) continue;
    const list = byCustomer.get(inv.customerId) ?? [];
    list.push(inv);
    byCustomer.set(inv.customerId, list);
  }

  for (const [customerId, unsorted] of byCustomer) {
    const invoices = unsorted.slice().sort((a, b) => String(a.invoiceDate).localeCompare(String(b.invoiceDate)));
    const customer = clientName.get(customerId) ?? customerId;
    const projectId = `proj_${customerId}`;
    // The client row spans the whole engagement, from the first invoice to the last due date.
    const lastDue = invoices.reduce((max, inv) => (String(inv.dueDate) > max ? String(inv.dueDate) : max), "");
    tasks.push({
      id: projectId,
      name: customer,
      expanded: true,
      startDate: invoices[0]!.invoiceDate!,
      endDate: lastDue,
      manuallyScheduled: true,
    });

    let previous: { invoice: InvoiceRow; payId: string } | null = null;

    invoices.forEach((inv, i) => {
      const phaseId = `${projectId}_phase_${i}`;
      const payId = `${projectId}_pay_${i}`;
      const status = paymentStatus(inv);
      const blocked = previous !== null && pastDueAndUnpaid(previous.invoice);
      const name = phaseName.get(inv.id) ?? `Phase ${i + 1}`;

      // Work phase: invoice date → due date. A blocked phase can't start; an unpaid but
      // unblocked phase shows how far through its dates it is.
      tasks.push({
        id: phaseId,
        parentId: projectId,
        name: `${blocked ? "⛔ " : ""}${name}`,
        startDate: inv.invoiceDate!,
        endDate: inv.dueDate!,
        manuallyScheduled: true,
        percentDone: blocked ? 0 : status === "pending" ? elapsedPercent(inv.invoiceDate!, inv.dueDate!, today) : 100,
        cls: blocked ? "flow-blocked" : `flow-${status}`,
        // Always explicit, so a phase turns back from red the moment it's unblocked.
        eventColor: blocked ? "red" : "green",
        blocked,
      });

      // Payment tranche milestone on the due date.
      const label =
        status === "partial"
          ? `Payment · ${money(inv.paidAmount, inv.currency)} of ${money(inv.total, inv.currency)}`
          : `Payment · ${money(inv.total, inv.currency)}`;
      tasks.push({
        id: payId,
        parentId: projectId,
        name: label,
        startDate: inv.dueDate!,
        duration: 0,
        milestone: true,
        manuallyScheduled: true,
        eventColor: COLOR[status],
        cls: `flow-pay-${status}`,
        customer,
        invoiceId: inv.id,
        invoiceNumber: inv.number,
        amount: inv.total,
        outstanding: inv.outstanding,
        currency: inv.currency,
        paymentStatus: status,
        payerUrl: inv.payerUrl,
      });

      dependencies.push({ id: `d${depId++}`, from: phaseId, to: payId, type: 2 });
      if (previous) dependencies.push({ id: `d${depId++}`, from: previous.payId, to: phaseId, type: 2 });

      previous = { invoice: inv, payId };
    });
  }

  return { tasks, dependencies };
}

/**
 * For a tranche's invoice, the phase its payment gates and whether that phase is
 * currently blocked. Used to describe what a payment just changed.
 */
export function gatedPhase(timeline: TimelineModel, invoiceId: string): { name: string; blocked: boolean } | null {
  const milestone = timeline.tasks.find((t) => t.milestone && t.invoiceId === invoiceId);
  if (!milestone) return null;
  const next = timeline.dependencies.find((d) => d.from === milestone.id);
  const phase = next && timeline.tasks.find((t) => t.id === next.to);
  if (!phase) return null;
  return { name: phase.name.replace(/^⛔ /, ""), blocked: Boolean(phase.blocked) };
}
