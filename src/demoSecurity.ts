import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";

export type DemoRole = "judge" | "operator";
export interface DemoIdentity { id: string; role: DemoRole }

interface SecurityOptions {
  judgePassword: string;
  operatorPassword: string;
  secureCookies: boolean;
  now?: () => number;
}

const SESSION_MS = 8 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const COOKIE = "flow_session";
const idPattern = /^INV2-[A-Z0-9-]+$/;

function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function validInvoiceId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value) && value.length <= 80;
}

export function createDemoSecurity(options: SecurityOptions) {
  if (options.judgePassword.length < 16 || options.operatorPassword.length < 16 ||
      equalSecret(options.judgePassword, options.operatorPassword)) {
    throw new Error("Demo passwords must be distinct and at least 16 characters long.");
  }
  const now = options.now ?? Date.now;
  const sessions = new Map<string, { role: DemoRole; expires: number }>();
  const attempts = new Map<string, { count: number; expires: number }>();
  const aiRequests = new Map<string, { count: number; expires: number }>();
  let totalAi = { count: 0, expires: now() + WINDOW_MS };
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: "4kb" }));

  function cleanup() {
    const time = now();
    for (const [id, session] of sessions) if (session.expires <= time) sessions.delete(id);
    for (const [key, entry] of attempts) if (entry.expires <= time) attempts.delete(key);
    for (const [key, entry] of aiRequests) if (entry.expires <= time) aiRequests.delete(key);
  }

  function isSameOrigin(req: Request): boolean {
    const origin = req.get("origin");
    const host = req.get("host");
    if (!origin || !host || req.get("sec-fetch-site") === "cross-site") return false;
    try { return origin === new URL(`${req.protocol}://${host}`).origin; } catch { return false; }
  }

  function identity(req: Request): DemoIdentity | null {
    const value = req.get("cookie")?.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
    const id = value?.slice(COOKIE.length + 1);
    if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
    const session = sessions.get(id);
    if (!session || session.expires <= now()) { if (session) sessions.delete(id); return null; }
    return { id, role: session.role };
  }

  const loginPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flow · Sign in</title><style>body{margin:0;background:#f4f6fb;color:#102344;font-family:Georgia,serif}.bar{background:#003087;color:white;padding:18px 6vw;font:700 18px sans-serif}.card{max-width:420px;margin:10vh auto;padding:36px;background:white;border:1px solid #dfe6f0;border-radius:12px;box-shadow:0 10px 40px #00308712}h1{font-size:30px;margin:0 0 8px}p{line-height:1.5;color:#52657e}label{display:block;margin:18px 0 6px;font:600 14px sans-serif}input,select,button{box-sizing:border-box;width:100%;padding:12px;border:1px solid #c7d3e2;border-radius:6px;font-size:16px}button{background:#0070ba;color:white;border:0;margin-top:24px;cursor:pointer;font-weight:700}small{display:block;margin-top:20px;color:#52657e}</style></head><body><div class="bar">Flow <span style="font-weight:400;font-size:13px"> / PayPal money copilot</span></div><main class="card"><h1>Welcome to Flow.</h1><p>Sign in to explore the sandbox demo.</p><form action="/auth/login" method="post"><label for="role">Access</label><select id="role" name="role"><option value="judge">Judge</option><option value="operator">Operator</option></select><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button type="submit">Sign in</button></form><small>Use the credentials provided by the demo owner.</small></main></body></html>`;

  router.get("/login", (_req, res) => { res.set("Cache-Control", "no-store").type("html").send(loginPage); });
  router.post("/auth/login", (req, res) => {
    if (!isSameOrigin(req)) { res.sendStatus(403); return; }
    cleanup();
    const ip = req.ip ?? "unknown";
    if (!attempts.has(ip) && attempts.size >= 10000) { res.sendStatus(429); return; }
    const entry = attempts.get(ip) ?? { count: 0, expires: now() + WINDOW_MS };
    if (entry.count >= 10) { res.status(429).send("Too many login attempts. Try again later."); return; }
    const role = req.body?.role;
    const password = typeof req.body?.password === "string" ? req.body.password.slice(0, 256) : "";
    const valid = (role === "judge" && equalSecret(password, options.judgePassword)) ||
      (role === "operator" && equalSecret(password, options.operatorPassword));
    if (!valid) {
      entry.count++; attempts.set(ip, entry);
      res.status(401).send("Invalid credentials. <a href='/login'>Try again</a>."); return;
    }
    attempts.delete(ip);
    if (sessions.size >= 1000) { res.status(503).send("Too many active sessions."); return; }
    const id = randomBytes(32).toString("hex");
    sessions.set(id, { role, expires: now() + SESSION_MS });
    res.cookie(COOKIE, id, { httpOnly: true, secure: options.secureCookies, sameSite: "strict", path: "/", maxAge: SESSION_MS });
    res.redirect(303, "/");
  });
  router.post("/auth/logout", (req, res) => {
    if (!isSameOrigin(req)) { res.sendStatus(403); return; }
    const session = identity(req);
    if (session) sessions.delete(session.id);
    res.clearCookie(COOKIE, { httpOnly: true, secure: options.secureCookies, sameSite: "strict", path: "/" });
    res.redirect(303, "/login");
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/api/health" || req.path === "/api/webhooks/paypal") { next(); return; }
    const session = identity(req);
    if (!session) {
      if (req.path.startsWith("/api/")) res.status(401).json({ error: "Sign in required." });
      else res.redirect(303, "/login");
      return;
    }
    res.locals.demoIdentity = session;
    res.locals.isActiveDemoSession = () => identity(req)?.id === session.id;
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !isSameOrigin(req)) { res.sendStatus(403); return; }
    // The legacy agent trusts tool-name approvals from the client. Disable its hosted API
    // rather than attempting to infer which remotely discovered MCP tools mutate state.
    if (/^\/api\/(chat\/stream|session\/reset)\/?$/i.test(req.path)) { res.sendStatus(403); return; }
    const operatorOnly = /^\/api\/approvals\/?$/i.test(req.path) ||
      /^\/api\/invoices\/[^/]+\/(remind|record-payment)\/?$/i.test(req.path);
    if (operatorOnly && session.role !== "operator") { res.sendStatus(403); return; }
    if (/^\/api\/(ai\/turn|collections\/draft|nudge)\/?$/i.test(req.path)) {
      cleanup();
      const key = req.ip ?? "unknown";
      const current = aiRequests.get(key) ?? { count: 0, expires: now() + WINDOW_MS };
      if (totalAi.expires <= now()) totalAi = { count: 0, expires: now() + WINDOW_MS };
      if (++current.count > 100 || ++totalAi.count > 400) { res.status(429).json({ error: "AI request limit reached. Try again later." }); return; }
      aiRequests.set(key, current);
    }
    next();
  });
  router.get("/api/auth/session", (_req, res) => res.json({ role: (res.locals.demoIdentity as DemoIdentity).role, authRequired: true }));
  return router;
}

export type ApprovedAction = "remind" | "record-payment";
export function approvalPayload(action: ApprovedAction, invoiceId: string, body: Record<string, unknown>): string | null {
  if (!validInvoiceId(invoiceId)) return null;
  if (action === "remind") {
    const note = body.note;
    if (typeof note !== "string" || !note.trim() || note.length > 1000) return null;
    return JSON.stringify({ invoiceId, note });
  }
  const amount = body.amount;
  const currency = body.currency;
  if (typeof amount !== "string" || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(amount) ||
      Number(amount) <= 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return JSON.stringify({ invoiceId, amount, currency });
}

export function createApprovalStore(now = Date.now) {
  const approvals = new Map<string, { sessionId: string; action: ApprovedAction; payload: string; expires: number }>();
  return {
    issue(sessionId: string, action: ApprovedAction, payload: string): string {
      for (const [key, value] of approvals) if (value.expires <= now()) approvals.delete(key);
      if (approvals.size >= 1000) throw new Error("Too many pending approvals.");
      const id = randomBytes(32).toString("hex");
      approvals.set(id, { sessionId, action, payload, expires: now() + 5 * 60 * 1000 });
      return id;
    },
    consume(id: unknown, sessionId: string, action: ApprovedAction, payload: string): boolean {
      if (typeof id !== "string") return false;
      const approval = approvals.get(id);
      if (!approval) return false;
      approvals.delete(id);
      return approval.expires > now() && approval.sessionId === sessionId && approval.action === action && approval.payload === payload;
    },
  };
}
