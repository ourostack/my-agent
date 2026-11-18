import { execFileSync } from "node:child_process";
import OpenAI from "openai";

// Use gh's signed-in account without saving its token to a file.
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
const client = new OpenAI({
  apiKey: gh("auth", "token"),
  baseURL: gh("api", "/copilot_internal/user", "--jq", ".endpoints.api"),
});

// Stream the model directly; there is no agent framework in between.
const stream = await client.chat.completions.create({
  model: "claude-opus-5.5",
  reasoning_effort: "max",
  max_tokens: 128000,
  messages: [{ role: "user", content: "say hi in exactly five words" }],
  stream: true,
});

// Copilot sends thinking separately from the answer, so dim only thinking.
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  if (delta?.reasoning_text) process.stdout.write(`\x1b[2m${delta.reasoning_text}\x1b[0m`);
  if (delta?.content) process.stdout.write(delta.content);
}
process.stdout.write("\n");
