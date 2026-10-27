import { randomUUID } from "node:crypto";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type Message,
  type ContentBlock,
  type Tool,
  type ToolChoice,
  type SystemContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { config } from "./config.js";

const DEFAULT_MODEL = "global.anthropic.claude-sonnet-4-6";

const client = new BedrockRuntimeClient({ region: config.aws.region });

/**
 * One line of the ndjson protocol between this server and the browser's thin
 * Bedrock adapter (web/src/studio/bedrockAdapter.ts): streamed AG-UI content
 * events, then a single final response, or an error.
 */
export type TurnLine =
  | { k: "event"; e: AgUiEvent }
  | { k: "complete"; r: LlmResponse }
  | { k: "error"; message: string };

// Subset of AG Studio's AgAiEvent we emit (content events only).
type AgUiEvent =
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string };

// Subset of AG Studio's AgLlmRequest we read.
interface LlmRequest {
  input: ConversationItem[];
  instructions?: string;
  tools?: { name: string; description?: string; parameters: unknown }[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  responseFormat?: { type: "text" } | { type: "json"; name: string; description?: string; schema: unknown };
}

type ConversationItem = Record<string, any>;

// Subset of AG Studio's AgLlmResponse we return.
interface LlmResponse {
  id: string;
  createdAt: number;
  model?: string;
  status: "completed" | "failed" | "incomplete";
  output: OutputItem[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

type OutputItem =
  | {
      id: string;
      kind: "output";
      type: "message";
      role: "assistant";
      status: "completed";
      content: { type: "text"; text: string; annotations: [] }[];
    }
  | {
      id: string;
      kind: "output";
      type: "function_call";
      callId: string;
      name: string;
      arguments: string;
      status: "completed";
    };

// --- AG request → Bedrock Converse -------------------------------------------------

function toSystem(request: LlmRequest): SystemContentBlock[] {
  const parts: string[] = [];
  if (request.instructions) parts.push(request.instructions);
  for (const item of request.input) {
    const role = item.role;
    if (item.type === "message" && (role === "system" || role === "developer")) {
      parts.push(textOf(item.content));
    }
  }
  if (request.responseFormat?.type === "json") {
    parts.push(
      `Respond with only a JSON object matching this schema (no prose):\n` +
        JSON.stringify(request.responseFormat.schema),
    );
  }
  return parts.filter(Boolean).map((text) => ({ text }));
}

function textOf(content: any[]): string {
  return (content ?? [])
    .map((c) => (c?.type === "text" ? c.text : c?.type === "refusal" ? c.refusal : ""))
    .join("");
}

function toMessages(items: ConversationItem[]): Message[] {
  const messages: Message[] = [];
  const push = (role: "user" | "assistant", block: ContentBlock) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content!.push(block);
    else messages.push({ role, content: [block] });
  };

  for (const item of items) {
    const role = item.role;
    if (item.type === "message" && (role === "system" || role === "developer")) continue;

    if (item.type === "message" && item.kind === "input") {
      const text = textOf(item.content);
      if (text) push("user", { text });
    } else if (item.type === "message" && item.kind === "output") {
      const text = textOf(item.content);
      if (text) push("assistant", { text });
    } else if (item.type === "function_call") {
      let input: any = {};
      try {
        input = JSON.parse(item.arguments || "{}");
      } catch {
        input = {};
      }
      push("assistant", { toolUse: { toolUseId: item.callId, name: item.name, input } });
    } else if (item.type === "function_call_output") {
      push("user", {
        toolResult: {
          toolUseId: item.callId,
          content: [{ text: typeof item.output === "string" ? item.output : JSON.stringify(item.output) }],
        },
      });
    }
  }

  // Converse requires the first message to be from the user.
  if (messages.length === 0 || messages[0]!.role !== "user") {
    messages.unshift({ role: "user", content: [{ text: "(begin)" }] });
  }
  return messages;
}

function toToolConfig(request: LlmRequest): { tools: Tool[]; toolChoice?: ToolChoice } | undefined {
  if (!request.tools?.length || request.toolChoice === "none") return undefined;
  const tools: Tool[] = request.tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.parameters as Record<string, unknown> },
    },
  })) as unknown as Tool[];
  let toolChoice: ToolChoice | undefined;
  if (request.toolChoice === "required") toolChoice = { any: {} };
  else if (typeof request.toolChoice === "object") toolChoice = { tool: { name: request.toolChoice.name } };
  else toolChoice = { auto: {} };
  return { tools, toolChoice };
}

// --- Streamed turn -----------------------------------------------------------------

/**
 * Runs a single AG Studio turn against Bedrock Converse and yields ndjson lines:
 * AG-UI content events as they stream, then a final consolidated response.
 */
export async function* runStudioTurn(
  request: LlmRequest,
  signal?: AbortSignal,
): AsyncGenerator<TurnLine> {
  const toolConfig = toToolConfig(request);
  const command = new ConverseStreamCommand({
    modelId: config.bedrock.modelId ?? DEFAULT_MODEL,
    system: toSystem(request),
    messages: toMessages(request.input),
    inferenceConfig: { maxTokens: 4096 },
    ...(toolConfig && { toolConfig }),
  });

  const messageId = `msg_${randomUUID()}`;
  let textStarted = false;
  let textAccum = "";
  // contentBlockIndex -> open tool call being streamed
  const toolByIndex = new Map<number, { toolUseId: string; name: string; input: string }>();
  const toolCalls: { toolUseId: string; name: string; input: string }[] = [];
  const usage: LlmResponse["usage"] = {};

  try {
    const response = await client.send(command, { abortSignal: signal });
    for await (const chunk of response.stream ?? []) {
      if (chunk.contentBlockStart?.start?.toolUse) {
        const idx = chunk.contentBlockStart.contentBlockIndex ?? 0;
        const { toolUseId, name } = chunk.contentBlockStart.start.toolUse;
        const tc = { toolUseId: toolUseId!, name: name!, input: "" };
        toolByIndex.set(idx, tc);
        yield { k: "event", e: { type: "TOOL_CALL_START", toolCallId: tc.toolUseId, toolCallName: tc.name } };
      } else if (chunk.contentBlockDelta?.delta) {
        const idx = chunk.contentBlockDelta.contentBlockIndex ?? 0;
        const delta = chunk.contentBlockDelta.delta;
        if (typeof delta.text === "string") {
          if (!textStarted) {
            textStarted = true;
            yield { k: "event", e: { type: "TEXT_MESSAGE_START", messageId, role: "assistant" } };
          }
          textAccum += delta.text;
          yield { k: "event", e: { type: "TEXT_MESSAGE_CONTENT", messageId, delta: delta.text } };
        } else if (delta.toolUse?.input !== undefined) {
          const tc = toolByIndex.get(idx);
          if (tc) {
            tc.input += delta.toolUse.input;
            yield { k: "event", e: { type: "TOOL_CALL_ARGS", toolCallId: tc.toolUseId, delta: delta.toolUse.input } };
          }
        }
      } else if (chunk.contentBlockStop) {
        const idx = chunk.contentBlockStop.contentBlockIndex ?? 0;
        const tc = toolByIndex.get(idx);
        if (tc) {
          toolCalls.push(tc);
          toolByIndex.delete(idx);
          yield { k: "event", e: { type: "TOOL_CALL_END", toolCallId: tc.toolUseId } };
        }
      } else if (chunk.metadata?.usage) {
        usage.inputTokens = chunk.metadata.usage.inputTokens;
        usage.outputTokens = chunk.metadata.usage.outputTokens;
        usage.totalTokens = chunk.metadata.usage.totalTokens;
      }
    }

    if (textStarted) yield { k: "event", e: { type: "TEXT_MESSAGE_END", messageId } };

    const output: OutputItem[] = [];
    if (textAccum) {
      output.push({
        id: messageId,
        kind: "output",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "text", text: textAccum, annotations: [] }],
      });
    }
    for (const tc of toolCalls) {
      output.push({
        id: `fc_${tc.toolUseId}`,
        kind: "output",
        type: "function_call",
        callId: tc.toolUseId,
        name: tc.name,
        arguments: tc.input || "{}",
        status: "completed",
      });
    }

    yield {
      k: "complete",
      r: { id: `resp_${randomUUID()}`, createdAt: Date.now(), model: config.bedrock.modelId ?? DEFAULT_MODEL, status: "completed", output, usage },
    };
  } catch (err) {
    yield { k: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
