# PayPal Hackathon Agent

A full-stack AI agent built with the **[Strands Agents](https://strandsagents.com) TypeScript SDK**,
running on **Amazon Bedrock**, with **PayPal** actions provided as tools over MCP.

- **Backend** — Express server that runs the agent and streams its output.
- **Frontend** — a two-view UI (plain HTML/JS, no build step): an agent **Chat**
  and an **Invoices dashboard** (AG Grid) with an AI "draft a friendly nudge" action.
- **CLI** — run the same agent from the terminal.

```
src/
  config.ts      env loading + Bedrock credential checks
  paypalMcp.ts   connects to PayPal's sandbox MCP server (agent tools)
  paypalAuth.ts  mints a fresh sandbox token from client credentials
  paypalRest.ts  lists invoices from the PayPal REST API (dashboard data)
  approval.ts    classifies money-moving tools for the approval gate
  sessions.ts    per-session agents (memory) + the approval hook
  agent.ts       builds the Strands agent (Bedrock + PayPal tools)
  nudge.ts       tool-less agent that drafts friendly payment reminders
  events.ts      normalizes the agent event stream for the UI
  server.ts      Express API + static file server
  cli.ts         terminal entry point
public/          UI: chat + AG Grid invoices dashboard
```

## Prerequisites

- **Node.js 22+**
- **AWS credentials** with permission to invoke your Bedrock model, and model
  access enabled in the [Bedrock console](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html).
- **(Optional) A PayPal sandbox MCP token** to enable PayPal tools.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values (a starter .env is already present)
```

Key environment variables (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | Bedrock model access |
| `BEDROCK_MODEL_ID` | Optional override; defaults to the SDK's default Bedrock model |
| `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET` | PayPal sandbox app credentials — the agent mints its own MCP token from these |
| `PAYPAL_SANDBOX_TOKEN` | Optional pre-minted token; used only if client credentials are absent |
| `PORT` | Server port (default `3000`) |

> `.env` is the source of truth: it's loaded with `override: true`, so values
> in `.env` win over anything already exported in your shell. This avoids a
> stale `PAYPAL_SANDBOX_TOKEN` in the environment shadowing the real config.

### PayPal authentication

The PayPal MCP server at `https://mcp.sandbox.paypal.com/sse` expects a bearer
token. Rather than pasting one in (sandbox tokens expire in ~9 hours and are
easy to get wrong), the app **mints a fresh token at startup** from your
`PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` via the sandbox OAuth endpoint
(`src/paypalAuth.ts`). Just set those two values and you're done.

If you ever see `Token signature verification failed`, it means a bad/expired
bearer token reached PayPal. With credential-based minting that shouldn't
happen; check that `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` are correct sandbox
values. You can mint one manually to verify:

```bash
curl -s https://api-m.sandbox.paypal.com/v1/oauth2/token \
  -u "$PAYPAL_CLIENT_ID:$PAYPAL_SECRET" \
  -d "grant_type=client_credentials"
```

Setting `PAYPAL_SANDBOX_TOKEN` is only a fallback for when client credentials
aren't available. Without any PayPal credentials the agent still runs, just
without PayPal tools.

> PayPal tools are wired via `npx mcp-remote`, which bridges the remote SSE
> endpoint to the agent and handles the auth header (the same setup as
> `.opencode/opencode.jsonc`). The first run downloads `mcp-remote` via npx.
> The minted token lasts the server's session; restart to refresh it.

## Run

**Web app (API + UI):**

```bash
npm run dev     # watch mode
# or
npm start
```

Open http://localhost:3000 and use the two tabs:

- **Chat** — talk to the agent (create invoices, look things up, etc.). The dot
  next to the title shows whether PayPal is configured.
- **Invoices** — a live AG Grid of your PayPal invoices. Select a row and click
  **Draft nudge ✨** to have the AI write a friendly payment reminder.

**CLI:**

```bash
npm run agent -- "Create a $25 sandbox invoice for jane@example.com"
```

**Type-check:**

```bash
npm run typecheck
```

## How it works

1. `createAgent()` builds a Strands `Agent`. Bedrock is the default model
   provider, so credentials come straight from the environment.
2. If PayPal credentials are present, `createPaypalMcpClient()` attaches the
   PayPal MCP server as a tool provider (using a freshly minted token). The
   model decides when to call PayPal tools (invoices, orders, refunds, …).
3. The server streams the agent's events as newline-delimited JSON; the browser
   renders text as it arrives and shows a note each time a tool is invoked.

### Per-session memory

Each browser gets a `sessionId` (generated client-side, kept in `localStorage`
and sent with every request). The server keeps **one agent instance per
session** (`src/sessions.ts`), so conversation history is scoped to that
session via the SDK's default sliding-window conversation manager. "New chat"
resets the session. Follow-up messages therefore remember earlier context —
e.g. approving an action without re-stating its details.

### Approval gate (human-in-the-loop)

Money-moving tools are gated. A `BeforeToolCallEvent` hook (`src/sessions.ts`)
checks each tool name against `isSensitiveTool()` (`src/approval.ts`): anything
implying a state change — create, capture, pay, send, refund, payout, etc. — is
**cancelled before it runs** unless the user approved it for the current turn.
Read-only lookups (get/list, `generate_invoice_number`, …) pass through freely.

The flow:

1. The agent tries a sensitive tool → the hook cancels it and tells the model
   approval is required. The model describes the action and asks the user.
2. The UI shows an **Approve / Deny** card with the exact tool input.
3. **Approve** re-sends the turn with that tool name in `approvals: [...]`, so
   the hook lets it through and the agent (still holding the details in session
   memory) executes it. **Deny** cancels it.

To gate more or fewer actions, edit the matchers in `src/approval.ts`.

### Invoices dashboard + AI nudge (AG Grid)

The **Invoices** tab renders live PayPal invoices in an [AG Grid](https://www.ag-grid.com/)
data grid (`GET /api/invoices`, backed by the PayPal Invoicing REST API in
`src/paypalRest.ts`). Selecting an invoice and clicking **Draft nudge** calls
`POST /api/nudge`, where a lightweight, tool-less Bedrock agent (`src/nudge.ts`)
writes a warm, friendly payment reminder you can copy and send — PayPal data +
AI + a data grid in one view.

> AG Grid Community (free) is loaded from a CDN to keep the no-build static UI.
> For the sponsor's **Best Use of AG Grid** award, this would be upgraded to
> **AG Studio** + the Studio Agent Framework in a React frontend.

## Deploy (Render)

A [`render.yaml`](./render.yaml) blueprint deploys the Express server as a Render
web service:

1. Push this repo to GitHub.
2. In Render, **New → Blueprint**, pick the repo. Render reads `render.yaml`.
3. Set the secret env vars when prompted: `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`
   (`AWS_REGION` defaults to `us-east-1`). Render provides `PORT` automatically.
4. Deploy. The health check path is `/api/health`.

Never commit secrets — `.env` is gitignored; configure them in the Render dashboard.

## Safety & limits (hackathon notes)

- Sandbox only — point at PayPal **sandbox** credentials, never live.
- Money-moving tool calls require explicit approval (see the approval gate
  above); the system prompt also asks the agent to confirm first.
- Sessions live in memory and are keyed only by a client-supplied id — fine for
  a demo, but add real auth + a persistent/expiring session store before any
  multi-user or public use. The per-run approval set assumes one in-flight
  request per session.
- No auth on the API. Don't expose this server publicly as-is.

## Next steps

- Persist sessions (and conversation history) in a store with expiry.
- Add authentication and per-user isolation on the API.
- Tests with a mocked model asserting tool-call arguments, the approval gate,
  and control flow.
