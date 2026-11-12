import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

let child: ChildProcess;
let origin: string;
let cwd: string;

before(async () => {
  const port = await new Promise<number>((accept) => {
    const socket = createServer();
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address(); assert(address && typeof address !== "string");
      socket.close(() => accept(address.port));
    });
  });
  origin = `http://localhost:${port}`;
  // Run from a directory without the developer's .env; no real credentials or PayPal calls.
  const preferred = "C:/Users/frazi/AppData/Local/Temp/opencode";
  const parent = process.env.OPENCODE_TEST_TMP ?? (existsSync(preferred) ? preferred : tmpdir());
  cwd = mkdtempSync(join(parent, "flow-security-"));
  const loader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
  child = spawn(process.execPath, ["--import", loader, resolve("src/server.ts")], {
    cwd, env: {
      ...process.env, PORT: String(port), AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test",
      AWS_REGION: "us-east-1", PAYPAL_CLIENT_ID: "", PAYPAL_SECRET: "", PAYPAL_SANDBOX_TOKEN: "",
      PAYPAL_WEBHOOK_ID: "", NODE_ENV: "test", RENDER: "false", DEMO_AUTH_REQUIRED: "true",
      DEMO_JUDGE_PASSWORD: "judge-test-password-123456", DEMO_OPERATOR_PASSWORD: "operator-test-password-123456",
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((accept, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Server did not start")), 15000);
    child.stdout!.on("data", (data: Buffer) => {
      output += data.toString();
      if (output.includes("Flow UI:")) { clearTimeout(timeout); accept(); }
    });
    child.on("exit", () => { clearTimeout(timeout); reject(new Error("Server exited before starting")); });
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    await new Promise<void>((done) => { child.once("exit", () => done()); child.kill(); });
  }
  if (cwd) rmdirSync(cwd);
});

it("enforces roles, CSRF, single-use approvals, and webhook configuration on the real server", async () => {
  const login = async (role: string, password: string) => {
    const res = await fetch(`${origin}/auth/login`, {
      method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role, password }),
    });
    assert.equal(res.status, 303);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };
  const post = (path: string, cookie: string, data: unknown, requestOrigin = origin) => fetch(`${origin}${path}`, {
    method: "POST", headers: { cookie, origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(data),
  });

  assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
  assert.equal((await post("/api/webhooks/paypal", "", {})).status, 503);
  const judge = await login("judge", "judge-test-password-123456");
  assert.equal((await post("/api/invoices/INV2-TEST/remind", judge, { note: "test" })).status, 403);
  assert.equal((await post("/api/approvals", judge, { action: "remind", invoiceId: "INV2-TEST", note: "test" })).status, 403);
  const operator = await login("operator", "operator-test-password-123456");
  assert.equal((await post("/api/approvals", operator, {}, "https://evil.example")).status, 403);
  assert.equal((await post("/api/invoices/INV2-TEST/remind", operator, { note: "test" })).status, 403);
  const prepared = await post("/api/approvals", operator, { action: "remind", invoiceId: "INV2-TEST", note: "test" });
  assert.equal(prepared.status, 200);
  const { approvalId } = await prepared.json() as { approvalId: string };
  // Approved execution reaches the fake-credential guard; it cannot send anything.
  assert.equal((await post("/api/invoices/INV2-TEST/remind", operator, { note: "test", approvalId })).status, 500);
  assert.equal((await post("/api/invoices/INV2-TEST/remind", operator, { note: "test", approvalId })).status, 403);
});
