import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import OpenAI from "openai";

// Use gh's signed-in account without saving its token to a file.
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
const client = new OpenAI({
  apiKey: gh("auth", "token"),
  baseURL: gh("api", "/copilot_internal/user", "--jq", ".endpoints.api"),
});

// The saved request holds the whole conversation, including thinking.
const file = "what-the-model-sees.json";
const request = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {
  model: "claude-opus-5.5",
  reasoning_effort: "max",
  max_tokens: 128000,
  messages: [],
  stream: true,
};

async function reply() {
  // Save exactly what goes to the model before starting the call.
  writeFileSync(file, JSON.stringify(request, null, 2));
  const stream = await client.chat.completions.create(request);
  const message: any = { role: "assistant", content: "" };
  for await (const chunk of stream) {
    const delta: any = chunk.choices[0]?.delta;
    if (!delta) continue;
    // Keep both readable thinking and its opaque signature for later turns.
    for (const key of ["content", "reasoning_text", "reasoning_opaque"]) {
      if (typeof delta[key] === "string") message[key] = (message[key] ?? "") + delta[key];
    }
    if (delta.reasoning_text) process.stdout.write(`\x1b[2m${delta.reasoning_text}\x1b[0m`);
    if (delta.content) process.stdout.write(delta.content);
  }
  process.stdout.write("\n");
  request.messages.push(message);
  // Checkpoint the completed reply too, so quitting loses no finished turns.
  writeFileSync(file, JSON.stringify(request, null, 2));
}

// If the last run stopped during a call, finish that pending turn first.
if (request.messages.at(-1)?.role === "user") await reply();

const terminal = createInterface({ input: process.stdin, output: process.stdout });
terminal.setPrompt("You: ");
terminal.prompt();
for await (const content of terminal) {
  request.messages.push({ role: "user", content });
  await reply();
  terminal.prompt();
}
