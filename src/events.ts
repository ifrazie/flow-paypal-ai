import type { Session } from "./sessions.js";

/** A simplified, UI-friendly view of the Strands agent event stream. */
export type UiEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "approval_required"; tool: string; input: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

/**
 * Runs one turn for a session and yields only the event kinds a UI cares about:
 * streamed text, "a tool is being called", approval requests, and completion.
 *
 * `approvals` is the set of sensitive tool names the user approved for this turn
 * (empty on a normal message). Any sensitive tool call not in that set is blocked
 * by the approval hook, and surfaced to the UI as an `approval_required` event.
 *
 * The raw stream is loosely typed here because the SDK's event union is large;
 * we narrow on the specific shapes documented for streaming.
 */
export async function* streamUiEvents(
  session: Session,
  prompt: string,
  approvals: string[] = [],
): AsyncGenerator<UiEvent> {
  session.approvedForRun = new Set(approvals);
  session.approvalRequests = [];

  try {
    for await (const event of session.agent.stream(prompt) as AsyncIterable<any>) {
      if (event?.type === "modelStreamUpdateEvent") {
        const inner = event.event;
        if (
          inner?.type === "modelContentBlockDeltaEvent" &&
          inner.delta?.type === "textDelta" &&
          typeof inner.delta.text === "string"
        ) {
          yield { type: "text", text: inner.delta.text };
        } else if (
          inner?.type === "modelContentBlockStartEvent" &&
          inner.start?.type === "toolUseStart" &&
          typeof inner.start.name === "string"
        ) {
          yield { type: "tool", name: inner.start.name };
        }
      }
    }

    for (const req of session.approvalRequests) {
      yield { type: "approval_required", tool: req.tool, input: req.input };
    }
    yield { type: "done" };
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    session.approvedForRun = new Set();
  }
}
