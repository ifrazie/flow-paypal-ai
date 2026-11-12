# Hosted demo security specification

Status: approved. Scope: the Flow Render demo and PayPal webhook.

## Objective and acceptance criteria

Judges can sign in and explore the sandbox dashboard, timeline, and AI assistant. An operator has a separate login for sensitive actions. Before public deployment:

1. Anonymous requests cannot read invoice data, create AI requests, or perform actions; the health check and PayPal webhook remain reachable.
2. Judge sessions cannot send reminders, record payments, or invoke PayPal mutation tools, including by calling an endpoint directly.
3. Operator reminder and recorded-payment actions require an explicit, server-validated approval for the exact action and inputs. An approval expires, cannot be replayed, and is not interchangeable between actions.
4. The webhook checks PayPal signatures before processing; failed verification is rejected and temporary verification failures allow PayPal to retry. The webhook prompts a fresh PayPal read, rather than trusting payment status from the payload.
5. Credentials stay server-side; login sessions are time-limited, HttpOnly, secure over HTTPS and protected against cross-site requests. Reject common login abuse and limit AI usage.
6. Production fails closed when required demo-access secrets are missing. Local development remains usable with explicitly documented configuration.
7. Judges receive access instructions through the submission, not passwords committed to the repository. No changes to real PayPal records or new external reminders are made as part of automated tests.

## Stack and commands

Node.js 22, TypeScript, Express 5, Vite, React, existing PayPal and Bedrock integrations. Prefer Node built-ins; ask before adding dependencies.

- Backend types: `npm run typecheck`
- Frontend types: `npx tsc --noEmit -p web/tsconfig.json`
- Build: `npm run build:web`
- Development: `npm run dev:server` and `npm run dev:web`
- Tests: add a deterministic, credential-free command and document it before deploying.

## Structure and style

- `src/`: authentication, authorization, approvals, webhook handling and tests.
- `web/src/`: login and operator approval interaction; preserve the current visual style.
- `README.md`, `.env.example`, `render.yaml`: setup and deployment guidance without actual secrets.
- Follow existing TypeScript formatting and Express conventions. Example: `if (!authorized) { res.sendStatus(403); return; }`.

## Testing strategy

Automated tests use fake credentials and mocked PayPal/Bedrock calls. Cover anonymous, judge, and operator routes; bad or expired sessions; cross-site requests; login rate limiting; approval input matching, expiry and replay; and verified, invalid and failed webhook verification. Type-check and build the application. Smoke-test both roles and the webhook against the deployed app without recording or sending a sandbox transaction unless explicitly approved.

## Boundaries

- Always: enforce authorization on the server; fail closed; document limits; do not print secrets.
- Ask first: add dependencies, increase paid resources or perform a live customer-facing transaction.
- Never: commit `.env`, `web/.env`, `seed-emails.md`, credentials, or silently weaken access controls.

## Implementation and verification checkpoints

1. Add testable access-control and approval primitives; test deny-by-default behavior.
2. Guard routes and webhook; limit or disable the legacy agent's mutation capability on the hosted demo until its approvals are enforced server-side.
3. Add judge/operator sign-in and operator action-approval flows; test end-to-end locally.
4. Configure Render's Virginia `0.5c-512mb` service using secrets supplied outside source control; verify role access and webhook handling before publishing judge credentials.

The existing MCP chat's tool-name-only approvals are insufficient for a public demo and must not be treated as an authorization mechanism. Payment polling remains the fallback for missed webhooks.
