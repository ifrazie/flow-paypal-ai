import { Agent, BedrockModel } from "@strands-agents/sdk";
import { config } from "./config.js";
import type { InvoiceRow } from "./paypalRest.js";

const NUDGE_SYSTEM_PROMPT = `You write short, warm, friendly payment reminder messages on behalf of a
freelancer or small business. Tone: upbeat and gracious, never demanding or threatening — a gentle
"just a heads-up!" nudge. 2-4 sentences. Address the recipient by name when provided. Mention the
amount and that it's easy to pay via the PayPal invoice. Do not invent facts beyond what you're given.
Output only the message text, no preamble or quotes.`;

let nudgeAgent: Agent | null = null;

// A tool-less agent is cheap to build and fast to run — no PayPal MCP process.
function getNudgeAgent(): Agent {
  if (nudgeAgent) return nudgeAgent;
  nudgeAgent = new Agent({
    systemPrompt: NUDGE_SYSTEM_PROMPT,
    printer: false,
    ...(config.bedrock.modelId
      ? { model: new BedrockModel({ modelId: config.bedrock.modelId, region: config.aws.region }) }
      : {}),
  });
  return nudgeAgent;
}

/** Extracts the concatenated text from an agent message's content blocks. */
function messageText(message: unknown): string {
  const blocks = (message as { content?: unknown[] })?.content ?? [];
  const parts: string[] = [];
  for (const block of blocks) {
    const b = block as { text?: unknown };
    if (typeof b.text === "string") parts.push(b.text);
    else if (typeof (b.text as { text?: unknown })?.text === "string") {
      parts.push((b.text as { text: string }).text);
    }
  }
  return parts.join("").trim();
}

/** Drafts a friendly reminder message for a single invoice. */
export async function draftNudge(invoice: InvoiceRow): Promise<string> {
  const prompt =
    `Write a friendly payment reminder for this invoice:\n` +
    `- Recipient: ${invoice.recipient}\n` +
    `- Amount: ${invoice.amount.toFixed(2)} ${invoice.currency}\n` +
    `- Invoice number: ${invoice.invoiceNumber}\n` +
    `- Status: ${invoice.status}`;

  const result = await getNudgeAgent().invoke(prompt);
  return messageText(result.lastMessage);
}
