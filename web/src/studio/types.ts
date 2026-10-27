// Shape of the payload returned by the server's GET /api/dashboard-data, mirroring
// the server's `DashboardData` (src/dashboard/data.ts). Rows are intentionally loose:
// AG Studio consumes each array as grid rows, and only a few date fields are read here.

export interface InvoiceRowLike {
  invoiceDate: string | null;
  [key: string]: unknown;
}
export interface DatedRowLike {
  date: string | null;
  [key: string]: unknown;
}

export interface DashboardData {
  asOf: string;
  customers: Record<string, unknown>[];
  invoices: InvoiceRowLike[];
  invoiceItems: Record<string, unknown>[];
  invoicePayments: DatedRowLike[];
  products: Record<string, unknown>[];
  plans: Record<string, unknown>[];
  transactions: DatedRowLike[];
  payouts: Record<string, unknown>[];
  balances: Record<string, unknown>[];
}
