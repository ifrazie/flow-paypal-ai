# Flow

Flow is an AI money copilot for freelancers and small agencies. It turns PayPal
invoices into a live financial dashboard and a payment-gated delivery timeline,
so the work unblocks the moment you get paid.

- **Dashboard:** an analytics view (AG Studio on Amazon Bedrock) with KPIs,
  collection rate, trends, and breakdowns, plus a natural-language assistant that
  builds new widgets on request.
- **Delivery timeline:** a Bryntum Gantt where every client is a project and every
  work phase is gated by a PayPal payment tranche. A past-due, unpaid tranche turns
  the next phase red and blocked. When PayPal reports the payment, the phase unblocks
  live, with no refresh.
- **AI collections:** drafts friendly, context-aware payment reminders for overdue
  invoices, which an authorized operator can send through PayPal.

PayPal is the only source of truth. Flow never marks anything paid on its own:
it reacts to what PayPal reports, picked up through a signed webhook and a polling
watcher.

## How Flow uses PayPal and AI

### PayPal (free sandbox)

Everything runs against the PayPal sandbox at `https://api-m.sandbox.paypal.com`.
Flow authenticates with a sandbox app's client ID and secret and mints its own
short-lived access tokens, so no bearer token needs to be pasted in.

| PayPal API | Role in Flow |
| :-- | :-- |
| OAuth 2.0 token (`/v1/oauth2/token`) | Exchanges the sandbox client ID/secret for short-lived access tokens that authorize every other call. |
| Invoicing v2 (`/v2/invoicing/invoices`) | Core data and actions: list and read invoices for the dashboard, analytics, and watcher; create and send invoices; record payments; send reminders; and cancel or delete invoices when resetting demo data. |
| Notifications / Webhooks (`/v1/notifications/*`) | Registers a webhook for `INVOICING.INVOICE.*` events and verifies each delivery's signature before acting on it. |
| Catalog Products (`/v1/catalogs/products`) | Enriches the dashboard catalogue view. |
| Billing Plans (`/v1/billing/plans`) | Subscription and plan data for the catalogue view. |
| Reporting (`/v1/reporting/transactions`, `/v1/reporting/balances`) | Used for richer analytics when available. The demo sandbox app returns 403 for these, so Flow degrades gracefully and falls back to invoice-derived data. |

### AI (Amazon Bedrock)

The chosen AI platform is **Amazon Bedrock**, running **Anthropic Claude Sonnet**
(`global.anthropic.claude-sonnet-4-6` by default, override with `BEDROCK_MODEL_ID`).
Bedrock appears in three places:

1. **Dashboard assistant.** The browser sends a request to the server, which runs a
   single Bedrock Converse turn (`@aws-sdk/client-bedrock-runtime`) and streams the
   result back as AG-UI events, letting a user build charts and widgets from plain
   language (`src/studioLlm.ts`).
2. **Collections assistant.** A lightweight, tool-less agent drafts warm payment
   reminders for overdue invoices (`src/nudge.ts`).
3. **Agent model provider.** The CLI/legacy agent is built with the Strands Agents
   SDK and uses Bedrock as its default model provider (`src/agent.ts`).

## Tools and sponsor integrations

- **PayPal Developer Platform (sandbox):** invoices, payments, reminders, catalog,
  billing, and signed webhooks. The single source of truth for all money state.
- **Amazon Bedrock (Claude Sonnet):** dashboard widget building and reminder drafting.
- **AG Studio (AG Grid):** the React analytics dashboard and its AI assistant. The
  legacy static UI uses AG Grid Community for the invoices grid.
- **Bryntum Gantt:** the payment-gated delivery timeline.
- **Render:** hosts the deployed web service (Express API plus the built React app).
- **Strands Agents SDK:** the agent runtime for the CLI and legacy chat.
- **Vite + React + TypeScript** on the frontend, **Express + TypeScript** on the backend.

## Project layout

```
src/
  config.ts          env loading and Bedrock credential checks
  paypalAuth.ts      mints a sandbox token from client credentials
  paypalInvoices.ts  invoice actions (record payment, remind) and webhook verification
  paypalRest.ts      lists invoices for the legacy grid
  webhookHandler.ts  verifies PayPal webhook signatures before acting
  paymentWatcher.ts  polls PayPal and broadcasts invoice changes
  demoSecurity.ts    login, roles, CSRF, rate limits, single-use approvals
  studioLlm.ts       runs an AG Studio turn against Bedrock Converse
  nudge.ts           tool-less Bedrock agent that drafts reminders
  agent.ts           Strands agent (Bedrock plus PayPal MCP tools) for the CLI
  server.ts          Express API, SSE stream, static file server
  cli.ts             terminal entry point
  dashboard/
    paypal.ts        PayPal REST client (invoices, catalog, billing, reporting)
    data.ts          shapes PayPal data into dashboard rows
    projects.ts      builds the Bryntum timeline from invoices
    seed.ts          re-runnable demo seeding
    registerWebhook.ts   registers the PayPal webhook
web/                 React app: AG Studio dashboard and Bryntum delivery timeline
public/              legacy static UI (chat plus AG Grid invoices), served at /legacy
```

## Prerequisites

- Node.js 22 or newer.
- AWS credentials with permission to invoke your Bedrock model, and model access
  enabled in the [Bedrock console](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html).
- A PayPal sandbox app (client ID and secret) from the
  [PayPal Developer Dashboard](https://developer.paypal.com/).
- An AG Studio license key for the dashboard (a trial key works).

## Setup

```bash
npm install
cp .env.example .env            # fill in the backend values
cp web/.env.example web/.env    # add VITE_AG_STUDIO_LICENSE
```

### Environment variables

Backend (`.env`):

| Variable | Purpose |
| :-- | :-- |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | Bedrock model access. `AWS_REGION` defaults to `us-east-1`. |
| `BEDROCK_MODEL_ID` | Optional model override. Defaults to Claude Sonnet. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET` | Sandbox app credentials. Flow mints its own tokens from these. |
| `PAYPAL_WEBHOOK_ID` | Set after registering the webhook, to enable signature verification. |
| `DEMO_AUTH_REQUIRED` | Set to `true` to require login (always on when hosted). |
| `DEMO_JUDGE_PASSWORD`, `DEMO_OPERATOR_PASSWORD` | Two distinct passwords, at least 16 characters each. |
| `PORT` | Server port, default `3000`. |

Frontend (`web/.env`):

| Variable | Purpose |
| :-- | :-- |
| `VITE_AG_STUDIO_LICENSE` | AG Studio license key, read at build time. |

Never commit secrets. `.env`, `web/.env`, and `seed-emails.md` are gitignored.

## Seed demo data

The seed reads `seed-emails.md` (one sandbox customer email per line) and creates a
story per customer: an overdue tranche that blocks the next phase, a client who pays
on time, one badly behind, a partial payment, and a new engagement. Invoices are sent
with PayPal notifications, so each sandbox customer can sign in and pay them.

`seed-emails.md` is not in the repo. Create it in the project root with your own
sandbox personal accounts (PayPal Developer Dashboard, Testing tools, Sandbox
accounts), one per line, optionally followed by a business and contact name:

```text
customer-one@personal.example.com | Initech | Mia Rossi
customer-two@personal.example.com | Soylent Corp | Zoe Haddad
customer-three@personal.example.com
```

```bash
npm run seed              # create and send the demo invoices
npm run seed -- --check   # list the customers and stories without touching PayPal
```

It is safe to re-run. Earlier `FLOW-` invoices are cleared first (recorded payments
are removed and the invoices cancelled without emails). Invoices a customer actually
paid through PayPal stay as payment history. At the end it prints a payment link for
the live demo.

## Run

```bash
# dev: Express API plus Vite dev server (two terminals)
npm run dev:server        # http://localhost:3000  (API)
npm run dev:web           # http://localhost:5173  (UI, proxies /api)

# production style: build the UI and let Express serve it
npm run build:web
npm start                 # http://localhost:3000
```

- **Dashboard:** click **Edit / Ask AI** and ask, for example, "Add a column chart of
  paid invoice revenue by month". The assistant builds the widget using Amazon Bedrock.
- **Delivery:** client projects on a timeline where each phase is gated by a PayPal
  payment tranche. Draft a reminder, open the invoice as the customer, or record a payment.

The legacy chat and invoices UI remains at `/legacy`.

CLI:

```bash
npm run agent -- "Create a $25 sandbox invoice for jane@example.com"
```

Type-check and tests:

```bash
npm run typecheck
npm test
```

## Roles and approvals

The hosted demo requires login and separates two roles:

- **Judge:** can view the dashboard and timeline and use the AI features. Read only.
- **Operator:** can also take money actions (record a payment, send a reminder).

Every money action requires a server-side, single-use approval bound to the exact
action, inputs, and session (`src/demoSecurity.ts`). Client-side approvals are not a
security boundary, so the legacy chat API is disabled when hosted. The server also
enforces same-origin checks, rate limits, and signed webhooks.

## Live payments

PayPal is the only source of truth; Flow never marks anything paid on its own.

1. **Watcher** (`src/paymentWatcher.ts`) checks PayPal's invoice list every 15 seconds
   and detects invoices that were paid, partially paid, refunded, sent, or cancelled.
   This works locally with no public URL.
2. **Live updates** are pushed to every open Flow window over `GET /api/events`
   (Server-Sent Events) with a fresh dashboard and timeline. The dashboard updates in
   place, the timeline unblocks the next phase, and a toast shows who paid.
3. **Webhooks** (deployed app) let PayPal call `/api/webhooks/paypal`, which asks the
   watcher to check immediately. The delivery's contents are never trusted, and its
   signature is verified first, so a forged webhook cannot mark anything paid.
   `PAYPAL_WEBHOOK_ID` is required for verification; until it is set, the webhook
   returns 503 and polling remains available.

To try a real customer payment, run `npm run seed`, open the link it prints (or pick a
tranche on **Delivery** and click **Open as customer**), sign in to the PayPal sandbox
as that customer, and pay. Flow updates within seconds. **Record payment** is the
operator shortcut: it records the payment in PayPal itself, so it travels the same path.
A tranche that is past due and not paid in full blocks the next phase; a partial payment
keeps it blocked until the balance is paid.

## Deploy (Render)

A [`render.yaml`](./render.yaml) blueprint deploys Flow (the Express API plus the built
React app) as one Render web service.

1. Push this repo to GitHub.
2. In Render, choose **New, Blueprint**, and pick the repo. Render reads `render.yaml`.
3. Set the secret env vars when prompted: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
   `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, and `VITE_AG_STUDIO_LICENSE`. `AWS_REGION`
   defaults to `us-east-1`, and Render provides `PORT`.
4. Set `DEMO_AUTH_REQUIRED=true` and two distinct random passwords (16 characters or
   more) as `DEMO_JUDGE_PASSWORD` and `DEMO_OPERATOR_PASSWORD`. Share judge credentials
   privately, never in the repository.
5. Deploy. The build runs `npm ci --include=dev && npm run build:web`, and the health
   check path is `/api/health`.
6. Register the PayPal webhook against the deployed URL, then set the printed
   `PAYPAL_WEBHOOK_ID` in Render:

   ```bash
   npm run webhook:register -- https://<your-service>.onrender.com
   ```

## Safety and limits

This is a sandbox demo, not a production payment application.

- Point at PayPal sandbox credentials only, never live.
- Authentication, sessions, rate limits, and the approval store are in-memory and
  intended for a single-instance demo. Add persistent identity, a durable session
  store, and a security review before any multi-user or public use.
- The judge login still exposes sandbox customer data and permits bounded AI calls, so
  share it only with trusted reviewers.

## License

Released under the [MIT License](./LICENSE).
