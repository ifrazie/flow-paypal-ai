// A thin AG Studio LLM adapter: it forwards each turn to this app's own
// /api/ai/turn endpoint, which runs the turn against Amazon Bedrock and streams
// AG-UI events back as ndjson. All AWS credentials and provider logic stay on
// the server (src/studioLlm.ts); the browser only reshapes the stream into the
// AgLlmResponseHandler AG Studio expects.

import type {
  AgAiEvent,
  AgLlmAdapter,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseHandler,
} from "ag-studio";

type TurnLine =
  | { k: "event"; e: AgAiEvent }
  | { k: "complete"; r: AgLlmResponse }
  | { k: "error"; message: string };

function runTurn(request: AgLlmRequest, signal?: AbortSignal): AgLlmResponseHandler {
  let resolveComplete!: (r: AgLlmResponse) => void;
  let rejectComplete!: (e: Error) => void;
  const complete = new Promise<AgLlmResponse>((resolve, reject) => {
    resolveComplete = resolve;
    rejectComplete = reject;
  });
  void complete.catch(() => {});

  async function* iterate(): AsyncIterableIterator<AgAiEvent> {
    const res = await fetch("/api/ai/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || body.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let response: AgLlmResponse | undefined;
    let failure: Error | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const raw = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!raw) continue;
          const line = JSON.parse(raw) as TurnLine;
          if (line.k === "event") yield line.e;
          else if (line.k === "complete") response = line.r;
          else if (line.k === "error") failure = new Error(line.message);
        }
      }
    } catch (err) {
      failure ??= err instanceof Error ? err : new Error(String(err));
    }

    if (failure) rejectComplete(failure);
    else if (response) resolveComplete(response);
    else rejectComplete(new Error("Stream ended without a final response."));
  }

  return { stream: { [Symbol.asyncIterator]: () => iterate() }, complete };
}

export function bedrockAdapter(): AgLlmAdapter {
  return {
    executeTurn: (request: AgLlmRequest, options?: { signal?: AbortSignal }) =>
      runTurn(request, options?.signal),
  };
}
