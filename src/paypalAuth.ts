import { config } from "./config.js";

/**
 * Resolves a bearer token for the PayPal sandbox MCP server.
 *
 * Prefers minting a fresh OAuth token from PAYPAL_CLIENT_ID / PAYPAL_SECRET so
 * there is no long-lived token to go stale or expire. Falls back to an
 * explicitly provided PAYPAL_SANDBOX_TOKEN only when client credentials are
 * absent. Returns null when neither is available.
 */
export async function resolvePaypalToken(): Promise<string | null> {
  if (config.paypal.clientId && config.paypal.secret) {
    try {
      return await mintSandboxToken(config.paypal.clientId, config.paypal.secret);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[paypal] Could not mint a sandbox token (${message}). ` +
          "Falling back to PAYPAL_SANDBOX_TOKEN if set.",
      );
    }
  }
  return config.paypal.sandboxToken ?? null;
}

async function mintSandboxToken(clientId: string, secret: string): Promise<string> {
  const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
  const res = await fetch(config.paypal.oauthUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("OAuth response did not include an access_token");
  }
  return data.access_token;
}
