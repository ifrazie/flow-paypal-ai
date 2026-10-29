// Shapes shared with the server (src/dashboard/projects.ts, src/paymentWatcher.ts).

import type { DashboardData } from "./studio/types";

export type PaymentStatus = "paid" | "partial" | "overdue" | "pending";

export interface GanttTask {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  duration?: number;
  milestone?: boolean;
  manuallyScheduled?: boolean;
  parentId?: string;
  expanded?: boolean;
  percentDone?: number;
  cls?: string;
  eventColor?: string;
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

export interface TimelineModel {
  tasks: GanttTask[];
  dependencies: { id: string; from: string; to: string; type?: number }[];
}

export interface InvoiceChange {
  kind: "paid" | "partial" | "refunded" | "cancelled" | "created" | "removed" | "updated";
  invoiceId: string;
  invoiceNumber: string;
  customer: string;
  currency: string;
  total: number;
  outstanding: number;
  phase?: { name: string; blocked: boolean };
}

export interface FlowUpdate {
  changes: InvoiceChange[];
  dashboard: DashboardData;
  timeline: TimelineModel;
}

export function money(value: number | undefined, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value ?? 0);
  } catch {
    return `${currency} ${Math.round(value ?? 0)}`;
  }
}

/** A one-line toast for the most important change in an update, if any. */
export function describeChanges(changes: InvoiceChange[]): string | null {
  const paid = changes.find((c) => c.kind === "paid");
  if (paid) {
    const unblocked = paid.phase && !paid.phase.blocked ? ` — “${paid.phase.name}” unblocked` : "";
    return `💸 ${paid.customer} paid ${money(paid.total, paid.currency)} (${paid.invoiceNumber})${unblocked}`;
  }
  const partial = changes.find((c) => c.kind === "partial");
  if (partial) {
    const blocked = partial.phase?.blocked ? ` “${partial.phase.name}” stays blocked until it's paid in full.` : "";
    return `${partial.customer} made a partial payment on ${partial.invoiceNumber}; ${money(partial.outstanding, partial.currency)} still due.${blocked}`;
  }
  const refunded = changes.find((c) => c.kind === "refunded");
  if (refunded) return `↩ ${refunded.invoiceNumber} for ${refunded.customer} was refunded.`;
  return null;
}
