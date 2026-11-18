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

// Add the tool even when resuming a conversation saved before it existed.
request.tools = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a text file from the local filesystem.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "The file path to read." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
}];
request.parallel_tool_calls = false;

async function reply() {
  // Save exactly what goes to the model before starting the call.
  writeFileSync(file, JSON.stringify(request, null, 2));
  const stream = await client.chat.completions.create(request);
  const message: any = { role: "assistant", content: "" };
  const calls = new Map();
  for await (const chunk of stream) {
    const delta: any = chunk.choices[0]?.delta;
    if (!delta) continue;
    // Keep both readable thinking and its opaque signature for later turns.
    for (const key of ["content", "reasoning_text", "reasoning_opaque"]) {
      if (typeof delta[key] === "string") message[key] = (message[key] ?? "") + delta[key];
    }
    // Tool names and JSON arguments arrive in pieces, just like answer text.
    for (const part of delta.tool_calls ?? []) {
      if (!calls.has(part.index)) calls.set(part.index, {
        id: "", type: "function", function: { name: "", arguments: "" },
      });
      const call = calls.get(part.index);
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
    }
    if (delta.reasoning_text) process.stdout.write(`\x1b[2m${delta.reasoning_text}\x1b[0m`);
    if (delta.content) process.stdout.write(delta.content);
  }
  process.stdout.write("\n");
  if (calls.size) message.tool_calls = [...calls.values()];
  request.messages.push(message);
  // Checkpoint the completed reply too, so quitting loses no finished turns.
  writeFileSync(file, JSON.stringify(request, null, 2));
}

// If the last run stopped during a call, finish that pending turn first.
if (request.messages.at(-1)?.role === "user") await reply();

// A pending tool call must not be followed by another user turn or model call.
if (!request.messages.at(-1)?.tool_calls) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  terminal.setPrompt("You: ");
  terminal.prompt();
  for await (const content of terminal) {
    request.messages.push({ role: "user", content });
    await reply();
    if (request.messages.at(-1)?.tool_calls) {
      terminal.close();
      break;
    }
    terminal.prompt();
  }
}

for (const call of request.messages.at(-1)?.tool_calls ?? []) {
  console.log("Tool request:", JSON.stringify(call, null, 2));
  try {
    if (call.function.name !== "read_file") throw new Error(`Unknown tool: ${call.function.name}`);
    const { path } = JSON.parse(call.function.arguments);
    console.log("Tool result:\n" + readFileSync(path, "utf8"));
  } catch (error) {
    console.error("Tool error:", error.message);
  }
  // Deliberately leave the tool call unanswered in the saved conversation.
  console.log("Paused: the model is waiting. The tool result has NOT been sent.");
}
