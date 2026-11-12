import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createApprovalStore, approvalPayload, createDemoSecurity } from "../src/demoSecurity.js";
import type { Server } from "node:http";
import { createWebhookHandler } from "../src/webhookHandler.js";

describe("hosted demo access", () => {
  let server: Server;
  let origin: string;
  const judge = "judge-password-123456789";
  const operator = "operator-password-123456789";
  let clock = 1_000_000;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(createDemoSecurity({ judgePassword: judge, operatorPassword: operator, secureCookies: false, now: () => clock }));
    app.get("/api/health", (_req, res) => res.json({ ok: true }));
    app.post("/api/webhooks/paypal", (_req, res) => res.sendStatus(200));
    app.get("/api/snapshot", (_req, res) => res.sendStatus(200));
    app.post("/api/ai/turn", (_req, res) => res.sendStatus(200));
    app.post("/api/approvals", (_req, res) => res.sendStatus(200));
    app.post("/api/invoices/:id/remind", (_req, res) => res.sendStatus(200));
    app.post("/api/chat/stream", (_req, res) => res.sendStatus(200));
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
  });
  after(() => server.close());

  async function login(role: string, password: string) {
    const response = await fetch(`${origin}/auth/login`, {
      method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role, password }),
    });
    assert.equal(response.status, 303);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  }

  it("fails closed with missing, equal, or short passwords", () => {
    assert.throws(() => createDemoSecurity({ judgePassword: "", operatorPassword: "", secureCookies: false }));
    assert.throws(() => createDemoSecurity({ judgePassword: judge, operatorPassword: judge, secureCookies: false }));
  });

  it("blocks anonymous data and permits health and webhook endpoints", async () => {
    assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    assert.equal((await fetch(`${origin}/api/webhooks/paypal`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${origin}/`, { redirect: "manual" })).status, 303);
  });

  it("restricts actions and legacy agent API to operator and denies cross-origin requests", async () => {
    const cookie = await login("judge", judge);
    assert.equal((await fetch(`${origin}/api/snapshot`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${origin}/api/ai/turn`, { method: "POST", headers: { cookie, origin } })).status, 200);
    assert.equal((await fetch(`${origin}/api/approvals`, { method: "POST", headers: { cookie, origin } })).status, 403);
    assert.equal((await fetch(`${origin}/api/invoices/INV2-ABCD/remind`, { method: "POST", headers: { cookie, origin } })).status, 403);
    assert.equal((await fetch(`${origin}/api/chat/stream`, { method: "POST", headers: { cookie, origin } })).status, 403);
    assert.equal((await fetch(`${origin}/api/ai/turn`, { method: "POST", headers: { cookie, origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(`${origin}/api/ai/turn`, { method: "POST", headers: { cookie } })).status, 403);
    const op = await login("operator", operator);
    assert.equal((await fetch(`${origin}/api/approvals`, { method: "POST", headers: { cookie: op, origin } })).status, 200);
    assert.equal((await fetch(`${origin}/api/chat/stream`, { method: "POST", headers: { cookie: op, origin } })).status, 403);
    clock += 8 * 60 * 60 * 1000 + 1;
    assert.equal((await fetch(`${origin}/api/snapshot`, { headers: { cookie: op } })).status, 401);
  });

  it("rate-limits failed logins", async () => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await fetch(`${origin}/auth/login`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "role=judge&password=wrong" })).status, 401);
    }
    assert.equal((await fetch(`${origin}/auth/login`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "role=judge&password=wrong" })).status, 429);
  });
});

describe("approval binding", () => {
  it("is bound to exact action, inputs, session, expires and is single-use", () => {
    let now = 0;
    const store = createApprovalStore(() => now);
    const body = { note: "Friendly reminder" };
    const payload = approvalPayload("remind", "INV2-ABCD-1234", body)!;
    const id = store.issue("session-a", "remind", payload);
    assert.equal(store.consume(id, "session-a", "remind", payload), true);
    assert.equal(store.consume(id, "session-a", "remind", payload), false);
    const wrong = store.issue("session-a", "remind", payload);
    assert.equal(store.consume(wrong, "session-a", "remind", approvalPayload("remind", "INV2-ABCD-1234", { note: "changed" })!), false);
    const other = store.issue("session-a", "remind", payload);
    assert.equal(store.consume(other, "session-b", "remind", payload), false);
    const expired = store.issue("session-a", "remind", payload);
    now += 5 * 60 * 1000 + 1;
    assert.equal(store.consume(expired, "session-a", "remind", payload), false);
    assert.equal(approvalPayload("record-payment", "../bad", { amount: "1.00", currency: "USD" }), null);
  });
});

describe("webhook verification", () => {
  it("rejects invalid signatures and retries failures without processing", async () => {
    let verified = false;
    let fail = false;
    let processed = 0;
    const app = express();
    app.use(express.json());
    app.post("/missing", createWebhookHandler({ verify: async () => true, onVerified: () => processed++ }));
    app.post("/webhook", createWebhookHandler({
      webhookId: "WH-TEST", verify: async () => { if (fail) throw new Error("unavailable"); return verified; },
      onVerified: () => processed++,
    }));
    const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
      const address = server.address(); assert(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const send = (path: string) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal((await send("/missing")).status, 503);
      assert.equal((await send("/webhook")).status, 401);
      fail = true;
      assert.equal((await send("/webhook")).status, 503);
      assert.equal(processed, 0);
      fail = false; verified = true;
      assert.equal((await send("/webhook")).status, 200);
      assert.equal(processed, 1);
    } finally { server.close(); }
  });
});
