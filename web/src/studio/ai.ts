// The AG Studio AI assistant, backed by Amazon Bedrock through this app's
// /api/ai/turn proxy (see web/src/studio/bedrockAdapter.ts and src/studioLlm.ts).

import { createAiHarness, type AgAiHarnessSetup, type AgAiPromptStarter } from "ag-studio";
import { bedrockAdapter } from "./bedrockAdapter";

const PROMPT_STARTERS: AgAiPromptStarter[] = [
  {
    label: "Overdue invoices",
    prompt: "Which customers owe the most on overdue invoices? Add a chart showing it.",
  },
  {
    label: "Revenue by month",
    prompt: "Add a chart of paid invoice revenue by month.",
  },
  {
    label: "Summarise this page",
    prompt: "Summarise what this page shows: every widget, the fields it reads, and what stands out.",
  },
];

export function buildAi(): AgAiHarnessSetup {
  const adapter = bedrockAdapter();
  return ({ api }) =>
    createAiHarness(api, {
      adapter,
      promptStarters: PROMPT_STARTERS,
    });
}
