import { Agent, BedrockModel, type AgentConfig } from "@strands-agents/sdk";
import { config } from "./config.js";
import { createPaypalMcpClient } from "./paypalMcp.js";

const SYSTEM_PROMPT = `You are a helpful commerce assistant for a PayPal hackathon demo.
You can use PayPal tools (create invoices, orders, capture payments, issue refunds,
list transactions, and more) to help the user.

Rules:
- Before taking any action that moves money or is hard to undo (creating or capturing
  a payment, issuing a refund, sending an invoice), briefly confirm the details with
  the user first.
- Never invent order ids, amounts, or customer data — ask or look them up with a tool.
- Keep answers concise and tell the user what you did and what happens next.`;

/**
 * Builds a Strands agent backed by Amazon Bedrock (the default provider) with
 * PayPal MCP tools attached when a sandbox token is available.
 *
 * `printer: false` silences the SDK's console streaming so callers own output
 * (the CLI prints the final message; the server streams events to the browser).
 */
export async function createAgent(): Promise<Agent> {
  const paypal = await createPaypalMcpClient();

  const options: AgentConfig = {
    systemPrompt: SYSTEM_PROMPT,
    printer: false,
    tools: paypal ? [paypal] : [],
  };

  // Use a specific Bedrock model only when explicitly configured; otherwise
  // fall back to the SDK's default Bedrock model.
  if (config.bedrock.modelId) {
    options.model = new BedrockModel({
      modelId: config.bedrock.modelId,
      region: config.aws.region,
    });
  }

  return new Agent(options);
}
