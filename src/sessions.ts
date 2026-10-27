import { randomUUID } from "node:crypto";
import { Agent, BeforeToolCallEvent } from "@strands-agents/sdk";
import { createAgent } from "./agent.js";
import { approvalRequiredMessage, isSensitiveTool } from "./approval.js";

export interface ApprovalRequest {
  tool: string;
  input: unknown;
}

export interface Session {
  id: string;
  agent: Agent;
  /** Tool names the user approved for the request currently being processed. */
  approvedForRun: Set<string>;
  /** Sensitive calls that were blocked during the current request. */
  approvalRequests: ApprovalRequest[];
}

const sessions = new Map<string, Session>();

/**
 * Returns the session for `id`, creating it (and its agent) on first use.
 * Each session owns one Agent, so conversation history is naturally scoped to
 * the session via the SDK's default sliding-window conversation manager.
 */
export async function getSession(id?: string): Promise<Session> {
  const sessionId = id ?? randomUUID();
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const agent = await createAgent();
  const session: Session = {
    id: sessionId,
    agent,
    approvedForRun: new Set(),
    approvalRequests: [],
  };

  // Approval gate: block money-moving tool calls unless approved this run.
  agent.addHook(BeforeToolCallEvent, (event) => {
    const name = event.toolUse.name;
    if (!isSensitiveTool(name)) return;
    if (session.approvedForRun.has(name)) return;

    session.approvalRequests.push({ tool: name, input: event.toolUse.input });
    event.cancel = approvalRequiredMessage(name);
  });

  sessions.set(sessionId, session);
  return session;
}

export function resetSession(id: string): boolean {
  return sessions.delete(id);
}
