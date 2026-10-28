// Builds a client-delivery timeline (Bryntum Gantt data) from PayPal invoices:
// each client is a project, each invoice a payment tranche, and each work phase
// is gated by the previous tranche's payment. A late payment visibly blocks the
// next phase — the heart of the "money gates the work" story.

import type { DashboardData } from "./data.js";

type PaymentStatus = "paid" | "overdue" | "pending";

export interface GanttTask {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  duration?: number;
  durationUnit?: string;
  manuallyScheduled?: boolean;
  expanded?: boolean;
  parentId?: string;
  milestone?: boolean;
  percentDone?: number;
  cls?: string;
  eventColor?: string;
  // Custom fields surfaced in columns / tooltips.
  invoiceId?: string;
  invoiceNumber?: string;
  amount?: number;
  currency?: string;
  paymentStatus?: PaymentStatus;
  blocked?: boolean;
}

export interface GanttDependency {
  id: string;
  from: string;
  to: string;
  // 2 = finish-to-start
  type?: number;
}

export interface TimelineModel {
  tasks: GanttTask[];
  dependencies: GanttDependency[];
}

type InvoiceRow = DashboardData["invoices"][number];

const COLOR: Record<PaymentStatus, string> = {
  paid: "green",
  overdue: "red",
  pending: "orange",
};

function paymentStatus(inv: InvoiceRow): PaymentStatus {
  if ((inv.statusGroup as string) === "Paid") return "paid";
  if ((inv.overdueAmount as number) > 0 || (inv.daysOverdue as number) > 0) return "overdue";
  return "pending";
}

export function buildTimeline(data: DashboardData): TimelineModel {
  const tasks: GanttTask[] = [];
  const dependencies: GanttDependency[] = [];
  let depId = 1;

  // Group invoices by customer, keep only those with usable dates.
  const byCustomer = new Map<string, InvoiceRow[]>();
  for (const inv of data.invoices) {
    if (!inv.invoiceDate || !inv.dueDate) continue;
    const key = inv.customerId as string;
    (byCustomer.get(key) ?? byCustomer.set(key, []).get(key)!).push(inv);
  }

  const customerName = new Map<string, string>();
  for (const c of data.customers) {
    customerName.set(c.id as string, (c.company as string) || (c.name as string) || (c.id as string));
  }

  for (const [custId, invoicesRaw] of byCustomer) {
    const invoices = invoicesRaw
      .slice()
      .sort((a, b) => String(a.invoiceDate).localeCompare(String(b.invoiceDate)));
    if (invoices.length === 0) continue;

    const projectId = `proj_${custId}`;
    tasks.push({
      id: projectId,
      name: customerName.get(custId) ?? custId,
      expanded: true,
    });

    let prevPayId: string | null = null;
    let prevStatus: PaymentStatus | null = null;

    invoices.forEach((inv, i) => {
      const phaseId = `${projectId}_phase_${i}`;
      const payId = `${projectId}_pay_${i}`;
      const status = paymentStatus(inv);
      const blocked = prevStatus === "overdue";

      // Work phase: invoice date → due date.
      tasks.push({
        id: phaseId,
        parentId: projectId,
        name: `${blocked ? "⛔ " : ""}Phase ${i + 1}`,
        startDate: String(inv.invoiceDate),
        endDate: String(inv.dueDate),
        manuallyScheduled: true,
        percentDone: status === "paid" ? 100 : blocked ? 0 : status === "pending" ? 50 : 20,
        cls: blocked ? "flow-blocked" : `flow-${status}`,
        ...(blocked && { eventColor: "red" }),
      });

      // Payment tranche milestone at the due date.
      tasks.push({
        id: payId,
        parentId: projectId,
        name: `Payment ${(inv.currency as string) ?? ""} ${(inv.total as number)?.toFixed?.(0) ?? inv.total}`,
        startDate: String(inv.dueDate),
        duration: 0,
        milestone: true,
        manuallyScheduled: true,
        eventColor: COLOR[status],
        cls: `flow-pay-${status}`,
        invoiceId: inv.id as string,
        invoiceNumber: inv.number as string,
        amount: inv.total as number,
        currency: inv.currency as string,
        paymentStatus: status,
      });

      dependencies.push({ id: `d${depId++}`, from: phaseId, to: payId, type: 2 });
      if (prevPayId) dependencies.push({ id: `d${depId++}`, from: prevPayId, to: phaseId, type: 2 });

      if (blocked) {
        tasks[tasks.length - 2]!.blocked = true;
      }

      prevPayId = payId;
      prevStatus = status;
    });
  }

  return { tasks, dependencies };
}
