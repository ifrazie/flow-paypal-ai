import { assertBedrockCredentials } from "./config.js";
import { getSession } from "./sessions.js";
import { streamUiEvents } from "./events.js";

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error('Usage: npm run agent -- "your prompt here"');
    process.exit(1);
  }

  assertBedrockCredentials();
  const session = await getSession();

  for await (const event of streamUiEvents(session, prompt)) {
    if (event.type === "text") {
      process.stdout.write(event.text);
    } else if (event.type === "tool") {
      process.stderr.write(`\n[tool: ${event.name}]\n`);
    } else if (event.type === "approval_required") {
      process.stderr.write(
        `\n[approval required: ${event.tool}] — re-run with this action approved to proceed.\n` +
          `  input: ${JSON.stringify(event.input)}\n`,
      );
    } else if (event.type === "error") {
      process.stderr.write(`\n[error: ${event.message}]\n`);
      process.exitCode = 1;
    }
  }
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
