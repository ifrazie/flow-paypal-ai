import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertBedrockCredentials, config, hasPaypalAuth } from "./config.js";
import { getSession, resetSession } from "./sessions.js";
import { streamUiEvents } from "./events.js";
import { listInvoices, type InvoiceRow } from "./paypalRest.js";
import { draftNudge } from "./nudge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

assertBedrockCredentials();

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, paypalTools: hasPaypalAuth() });
});

// Live PayPal invoices for the dashboard grid.
app.get("/api/invoices", async (_req, res) => {
  try {
    const invoices = await listInvoices();
    res.json({ invoices });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Drafts a friendly AI payment reminder for one invoice (the "nudge").
app.post("/api/nudge", async (req, res) => {
  const invoice = req.body?.invoice as InvoiceRow | undefined;
  if (!invoice || typeof invoice.recipient !== "string") {
    res.status(400).json({ error: "Body must include an 'invoice' object." });
    return;
  }
  try {
    const message = await draftNudge(invoice);
    res.json({ message });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/session/reset", (req, res) => {
  const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
  if (!sessionId) {
    res.status(400).json({ error: "Body must include 'sessionId'." });
    return;
  }
  resetSession(sessionId);
  res.json({ ok: true });
});

/**
 * Streams the agent's response as newline-delimited JSON (one UiEvent per line).
 *
 * Body: { prompt: string, sessionId: string, approvals?: string[] }
 *  - `sessionId` selects the per-user conversation (and its memory).
 *  - `approvals` lists sensitive tool names the user approved for this turn.
 */
app.post("/api/chat/stream", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined;
  const approvals: string[] = Array.isArray(req.body?.approvals)
    ? req.body.approvals.filter((t: unknown): t is string => typeof t === "string")
    : [];

  if (!prompt) {
    res.status(400).json({ error: "Body must include a non-empty 'prompt' string." });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  try {
    const session = await getSession(sessionId);
    // Echo the resolved session id so the client can persist it on first use.
    res.write(`${JSON.stringify({ type: "session", sessionId: session.id })}\n`);

    for await (const event of streamUiEvents(session, prompt, approvals)) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.write(`${JSON.stringify({ type: "error", message })}\n`);
  } finally {
    res.end();
  }
});

app.listen(config.server.port, () => {
  console.log(`\n  Agent UI:  http://localhost:${config.server.port}`);
  console.log(
    `  PayPal tools: ${hasPaypalAuth() ? "enabled" : "disabled (set PAYPAL_CLIENT_ID/PAYPAL_SECRET)"}\n`,
  );
});
