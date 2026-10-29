import { config as loadEnv } from "dotenv";

// `override: true` makes .env the source of truth. Without it, a stale value
// already exported in the shell (e.g. an old PAYPAL_SANDBOX_TOKEN) would win
// and cause confusing auth failures.
loadEnv({ override: true });

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export const config = {
  aws: {
    region: optional("AWS_REGION") ?? "us-east-1",
    accessKeyId: optional("AWS_ACCESS_KEY_ID"),
    secretAccessKey: optional("AWS_SECRET_ACCESS_KEY"),
  },
  bedrock: {
    // Leave undefined to use the Strands default Bedrock model.
    modelId: optional("BEDROCK_MODEL_ID"),
  },
  paypal: {
    clientId: optional("PAYPAL_CLIENT_ID"),
    secret: optional("PAYPAL_SECRET"),
    // Optional pre-minted token; used only if client credentials are absent.
    sandboxToken: optional("PAYPAL_SANDBOX_TOKEN"),
    mcpUrl: "https://mcp.sandbox.paypal.com/sse",
    oauthUrl: "https://api-m.sandbox.paypal.com/v1/oauth2/token",
    apiBase: "https://api-m.sandbox.paypal.com",
    // Set after registering the webhook (npm run webhook:register); enables signature checks.
    webhookId: optional("PAYPAL_WEBHOOK_ID"),
  },
  server: {
    port: Number(optional("PORT") ?? 3000),
  },
} as const;

/** True when the agent has some way to authenticate to PayPal. */
export function hasPaypalAuth(): boolean {
  return Boolean((config.paypal.clientId && config.paypal.secret) || config.paypal.sandboxToken);
}

export function assertBedrockCredentials(): void {
  if (!config.aws.accessKeyId || !config.aws.secretAccessKey) {
    throw new Error(
      "Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY " +
        "(and AWS_REGION) in your .env — Bedrock is the agent's model provider.",
    );
  }
  // The AWS SDK reads these from the environment; make sure a region is present.
  process.env.AWS_REGION ??= config.aws.region;
}
