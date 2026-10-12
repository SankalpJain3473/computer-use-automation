// npm run agent-demo  (needs the target app, `npm run server`, and OPENROUTER_API_KEY)
try {
  process.loadEnvFile();
} catch {
  /* env may already be set */
}

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { nanoid } from "nanoid";
import { maskKnownValues, redactDeep } from "../src/guardrails/redact.js";
import { currentModel } from "../src/llm/model.js";
import { readKeys, bearer } from "./keys.mjs";

const API = process.env.CAPABILITY_API ?? "http://localhost:4180";
const MODEL = currentModel();
const AUTH = bearer(readKeys().agent);

const DEFAULT_QUESTIONS = [
  "Member 12345 is on the phone asking how much is in their savings account. What should I tell them?",
  "Can you check the savings balance for member 99999?",
  "Member 23456 wants to open a new savings sub-account with a $40.00 opening deposit. Please do it and tell me the new account number.",
];

const SYSTEM = `You assist credit union tellers. You can only read or change the core banking system through the tools provided; you have no other access.
- Never invent balances, account numbers, or outcomes. Report exactly what a tool returns.
- A result with state BUSINESS_OUTCOME (for example MEMBER_NOT_FOUND) is a valid, final answer from the bank's system. Relay it plainly; do not retry or guess.
- Some tools perform irreversible actions and wait for a human operator to confirm. The tool result you receive is the final outcome after that confirmation.
- Answer the teller in one or two sentences.`;

interface ToolCallLog {
  tool: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  httpStatus: number;
  firstState: string;
  pausedForHuman?: { reason: string; operatorUrl: string };
  finalState: string;
  result: unknown;
}

async function invoke(name: string, args: Record<string, unknown>, idempotencyKey: string): Promise<ToolCallLog> {
  const res = await fetch(`${API}/api/capabilities/${name}/invoke`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ params: args, idempotencyKey }),
  });
  const body = await res.json();
  const log: ToolCallLog = {
    tool: name,
    args,
    idempotencyKey,
    httpStatus: res.status,
    firstState: body.state ?? body.error,
    finalState: body.state ?? body.error,
    result: body.result ?? { error: body.error, message: body.message },
  };
  if (res.status === 202 && body.state === "AWAITING_HUMAN") {
    log.pausedForHuman = { reason: body.intervention.reason, operatorUrl: `${API}${body.intervention.operatorUrl}` };
    console.log(`    paused for a human: ${body.intervention.reason}`);
    console.log(`    operator console:   ${API}${body.intervention.operatorUrl}`);
    let run = body;
    for (let i = 0; i < 40 && !["COMPLETED", "BUSINESS_OUTCOME", "FAILED"].includes(run.state); i++) {
      run = await (await fetch(`${API}/api/runs/${body.runId}?wait=terminal&timeoutMs=15000`, { headers: AUTH })).json();
    }
    log.finalState = run.state;
    log.result = run.result;
  }
  return log;
}

async function ask(client: OpenAI, tools: OpenAI.Chat.Completions.ChatCompletionTool[], question: string) {
  console.log(`\nTeller: ${question}`);
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: question },
  ];
  const calls: ToolCallLog[] = [];
  for (let turn = 0; turn < 4; turn++) {
    const resp = await client.chat.completions.create({ model: MODEL, tools, tool_choice: "auto", messages }, { timeout: 60_000, maxRetries: 2 });
    const msg = resp.choices[0]?.message;
    if (!msg) throw new Error("model returned no message");
    messages.push(msg);
    const toolCalls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (!toolCalls.length) {
      console.log(`Agent:  ${msg.content}`);
      return { question, calls, answer: msg.content ?? "" };
    }
    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* leave empty; the server will reject it with a typed error */
      }
      console.log(`  -> ${call.function.name}(${JSON.stringify(args)})`);
      const log = await invoke(call.function.name, args, `agent-demo-${call.id}`);
      console.log(`  <- ${log.httpStatus} ${log.finalState} ${JSON.stringify(log.result)}`);
      calls.push(log);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ state: log.finalState, result: log.result }) });
    }
  }
  return { question, calls, answer: "(no final answer within 4 turns)" };
}

async function main() {
  const tools = (await (await fetch(`${API}/api/capabilities?format=openai`, { headers: AUTH })).json()) as OpenAI.Chat.Completions.ChatCompletionTool[];
  if (!tools.length) {
    console.error("No approved capabilities are offered to agents yet. Approve one first (see README).");
    process.exit(1);
  }
  console.log(`Agent sees ${tools.length} approved tool(s): ${tools.map((t) => (t.type === "function" ? t.function.name : "")).join(", ")}`);

  const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" });
  const questions = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_QUESTIONS;
  const sessions = [];
  for (const q of questions) sessions.push(await ask(client, tools, q));

  const known = new Set<string>();
  for (const s of sessions) {
    for (const m of s.question.match(/\b\d{4,}\b/g) ?? []) known.add(m);
    for (const c of s.calls) for (const v of Object.values(c.args)) known.add(String(v));
  }
  const transcript = maskKnownValues(redactDeep({ model: MODEL, api: API, tools, sessions }), [...known]);
  const dir = path.join(process.cwd(), "evidence", `agent-demo-${nanoid(6)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "transcript.json"), JSON.stringify(transcript, null, 2));
  const md = [
    `# Agent demo transcript`,
    ``,
    `Model \`${MODEL}\` was given the capability catalog from \`GET /api/capabilities?format=openai\` and chose every tool call itself. Member IDs and account numbers are masked.`,
    ...transcript.sessions.flatMap((s) => [
      ``,
      `## Teller: ${s.question}`,
      ...s.calls.map(
        (c) =>
          `- **${c.tool}**(${JSON.stringify(c.args)}) -> HTTP ${c.httpStatus}, ${c.pausedForHuman ? `paused (${c.pausedForHuman.reason}) then ` : ""}**${c.finalState}**: \`${JSON.stringify(c.result)}\``
      ),
      ``,
      `**Agent:** ${s.answer}`,
    ]),
  ].join("\n");
  writeFileSync(path.join(dir, "transcript.md"), md + "\n");
  console.log(`\nTranscript: ${dir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
