import { McpClient } from "@strands-agents/sdk";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "./config.js";
import { resolvePaypalToken } from "./paypalAuth.js";

/**
 * Connects to PayPal's sandbox MCP server and exposes its tools to the agent.
 *
 * We bridge to the remote SSE endpoint with `mcp-remote` (run via npx), which
 * mirrors the working configuration in `.opencode/opencode.jsonc` and handles
 * the SSE transport + auth header for us. The bearer token is minted fresh from
 * client credentials (see resolvePaypalToken) to avoid stale-token failures.
 *
 * Returns `null` when no PayPal credentials are configured, so the agent can
 * still run without PayPal tools.
 */
export async function createPaypalMcpClient(): Promise<McpClient | null> {
  const token = await resolvePaypalToken();
  if (!token) {
    console.warn(
      "[paypal] No PayPal credentials configured — starting the agent without PayPal tools. " +
        "Set PAYPAL_CLIENT_ID and PAYPAL_SECRET (or PAYPAL_SANDBOX_TOKEN) in your .env.",
    );
    return null;
  }

  return new McpClient({
    prefix: "paypal",
    transport: new StdioClientTransport({
      command: "npx",
      args: [
        "mcp-remote",
        config.paypal.mcpUrl,
        "--header",
        `Authorization: Bearer ${token}`,
        "--transport",
        "sse-only",
      ],
    }),
  });
}
