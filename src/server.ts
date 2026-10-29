import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { assertBedrockCredentials, config, hasPaypalAuth } from "./config.js";
import { getSession, resetSession } from "./sessions.js";
import { streamUiEvents } from "./events.js";
import { listInvoices, type InvoiceRow } from "./paypalRest.js";
import { draftNudge } from "./nudge.js";
import { resolvePaypalToken } from "./paypalAuth.js";
import { getDashboardData } from "./dashboard/data.js";
import { buildTimeline } from "./dashboard/projects.js";
import { runStudioTurn } from "./studioLlm.js";
import { flowEvents, requestCheck, startPaymentWatcher, type FlowUpdate } from "./paymentWatcher.js";
import { recordInvoicePayment, verifyWebhookSignature } from "./paypalInvoices.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDist = join(__dirname, "..", "web", "dist");

assertBedrockCredentials();

const app = express();
app.use(express.json());
// Built React app (Flow dashboard). Legacy vanilla UI stays available under /legacy.
app.use(express.static(webDist));
app.use("/legacy", express.static(join(__dirname, "..", "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, paypalTools: hasPaypalAuth() });
});

// AG Studio AI assistant turn: the browser's thin Bedrock adapter POSTs an
// AgLlmRequest here; we run one Bedrock Converse turn and stream AG-UI events
// back as ndjson. Keeps AWS credentials server-side.
app.post("/api/ai/turn", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const controller = new AbortController();
  // Abort the Bedrock call only if the client disconnects before we finish.
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    for await (const line of runStudioTurn(req.body, controller.signal)) {
      res.write(`${JSON.stringify(line)}\n`);
    }
  } catch (err) {
    res.write(`${JSON.stringify({ k: "error", message: err instanceof Error ? err.message : String(err) })}\n`);
  } finally {
    res.end();
  }
});

// Collections: AI-draft a friendly reminder for a specific overdue invoice.
app.post("/api/collections/draft", async (req, res) => {
  const invoiceId = typeof req.body?.invoiceId === "string" ? req.body.invoiceId : "";
  if (!invoiceId) {
    res.status(400).json({ error: "Body must include 'invoiceId'." });
    return;
  }
  try {
    const data = await getDashboardData();
    const inv = data.invoices.find((i) => i.id === invoiceId);
    if (!inv) {
      res.status(404).json({ error: "Invoice not found." });
      return;
    }
    const cust = data.customers.find((c) => c.id === inv.customerId);
    const message = await draftNudge({
      id: inv.id,
      invoiceNumber: inv.number,
      recipient: (cust?.name as string) || (inv.customerId as string),
      amount: inv.total,
      currency: inv.currency,
      status: inv.status,
      date: inv.invoiceDate ?? "",
    });
    res.json({ message, invoiceNumber: inv.number });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Collections: send a reminder for an invoice via PayPal (the approved action).
app.post("/api/invoices/:id/remind", async (req, res) => {
  const id = req.params.id;
  const note = typeof req.body?.note === "string" ? req.body.note : "Just a friendly reminder about your invoice.";
  try {
    const token = await resolvePaypalToken();
    if (!token) {
      res.status(503).json({ error: "PayPal not configured." });
      return;
    }
    const r = await fetch(`https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${id}/remind`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "A friendly reminder about your invoice", note, send_to_recipient: true }),
    });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ error: `PayPal remind ${r.status}: ${text.slice(0, 200)}` });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Full dashboard dataset (invoices, transactions, products, plans, balances → flat rows)
// for the AG Studio data engine.
app.get("/api/dashboard-data", async (_req, res) => {
  try {
    const data = await getDashboardData();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Client-delivery timeline (Bryntum Gantt data): phases gated by invoice payments.
app.get("/api/projects", async (_req, res) => {
  try {
    const data = await getDashboardData();
    res.json(buildTimeline(data));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Dashboard data and delivery timeline in one snapshot, built from the same PayPal read.
app.get("/api/snapshot", async (_req, res) => {
  try {
    const dashboard = await getDashboardData();
    res.json({ dashboard, timeline: buildTimeline(dashboard) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Live updates: a Server-Sent Events stream. Whenever PayPal reports an invoice change
// (a customer pays, a payment is recorded, an invoice is sent or cancelled), every open
// Flow window receives the change plus a fresh dashboard and timeline.
app.get("/api/events", (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  const onUpdate = (update: FlowUpdate) => res.write(`event: update\ndata: ${JSON.stringify(update)}\n\n`);
  flowEvents.on("update", onUpdate);
  // Comments keep idle connections open through proxies.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(heartbeat);
    flowEvents.off("update", onUpdate);
  });
});

// Records the outstanding balance as paid in PayPal (the demo stand-in for a customer
// paying). Flow then sees the change from PayPal, exactly like a real payment.
app.post("/api/invoices/:id/record-payment", async (req, res) => {
  try {
    const result = await recordInvoicePayment(req.params.id);
    requestCheck();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// PayPal webhook receiver. The event is only a nudge to re-check PayPal right away; its
// contents are never trusted, so a forged delivery can't mark anything paid. With
// PAYPAL_WEBHOOK_ID set, deliveries are also signature-checked with PayPal.
app.post("/api/webhooks/paypal", async (req, res) => {
  res.json({ ok: true });
  const webhookId = config.paypal.webhookId;
  if (webhookId) {
    const verified = await verifyWebhookSignature(req.headers, req.body, webhookId).catch(() => false);
    if (!verified) {
      console.warn("[webhook] ignored a delivery that failed PayPal signature verification");
      return;
    }
  }
  console.log(`[webhook] ${req.body?.event_type ?? "event"} received; checking PayPal`);
  requestCheck();
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

// SPA fallback: serve the React app's index.html for any non-API GET route.
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) return next();
  const indexHtml = join(webDist, "index.html");
  if (existsSync(indexHtml)) return res.sendFile(indexHtml);
  next();
});

app.listen(config.server.port, () => {
  console.log(`\n  Flow UI:  http://localhost:${config.server.port}`);
  console.log(
    `  PayPal:   ${hasPaypalAuth() ? "enabled" : "disabled (set PAYPAL_CLIENT_ID/PAYPAL_SECRET)"}`,
  );
  if (hasPaypalAuth()) startPaymentWatcher();
  console.log("");
});
