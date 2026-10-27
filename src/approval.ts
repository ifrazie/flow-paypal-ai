/**
 * Human-in-the-loop gate for money-moving actions.
 *
 * PayPal MCP tools are exposed to the agent with a `paypal_` prefix. We treat any
 * tool whose name implies a state change that moves money or is hard to undo as
 * "sensitive": it cannot run until the user explicitly approves it for the
 * current request. Read-only lookups (get/list/show, generating an invoice
 * number, tracking, etc.) are never gated.
 */
const SENSITIVE_VERBS =
  /(create|capture|pay|send|refund|payout|disburse|authorize|void|delete|cancel|update|subscribe|activate|suspend)/i;

// Explicit allow-list for read-only tools whose names happen to contain a
// sensitive-looking substring but do not change state.
const ALWAYS_ALLOWED = new Set(["generate_invoice_number"]);

export function isSensitiveTool(toolName: string): boolean {
  const bare = toolName.replace(/^paypal_/, "");
  if (ALWAYS_ALLOWED.has(bare)) return false;
  return SENSITIVE_VERBS.test(bare);
}

/** The message handed back to the model when a sensitive call is blocked. */
export function approvalRequiredMessage(toolName: string): string {
  return (
    `The "${toolName}" action requires explicit user approval and was NOT executed. ` +
    `Do not retry it. Clearly describe to the user exactly what this action will do ` +
    `(amounts, recipients, ids) and ask them to approve or deny it, then stop and wait.`
  );
}
