// In-memory set of invoice ids that have been marked paid via the dev
// "simulate payment" endpoint or a PayPal webhook. The data transform honors
// these so the dashboard and the delivery timeline both reflect a payment
// immediately, without waiting for PayPal sandbox state to catch up.
export const paidInvoiceIds = new Set<string>();
