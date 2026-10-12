import OpenAI from "openai";
import type { Page } from "playwright";
import { captureSnapshot, renderSnapshotForPrompt, type ElementInfo } from "../perception/snapshot.js";
import { AGENT_TOOLS, SYSTEM_PROMPT } from "./tools.js";
import { currentModel } from "./model.js";
import { assertOriginAllowed, assertActionTypeAllowed } from "../guardrails/policy.js";
import type { RunLogger } from "../logging/logger.js";
import type { SessionManager } from "../escalation/session-manager.js";
import type { Step } from "../artifact/schema.js";

export interface DiscoveryOutcome {
  success: boolean;
  summary: string;
  recordedSteps: Step[];
  extractedOutputs: Record<string, string>;
  stopReason: "finished" | "max_steps" | "escalated_unresolved";
}

export interface DiscoveryOptions {
  goal: string;
  page: Page;
  logger: RunLogger;
  sessionManager: SessionManager;
  capabilityName: string;
  // This run's input values; typed values matching one are recorded as {{param}}.
  seedParams: Record<string, string>;
  maxSteps?: number;
  model?: string;
}

export function templatize(value: string, seedParams: Record<string, string>): string {
  for (const [name, v] of Object.entries(seedParams)) {
    if (v && sameValue(value, v)) return `{{${name}}}`;
  }
  return value;
}

// A model may type the seed "60.00" as 60 or "$60.00"; missing that would hard-code the amount.
function sameValue(typed: string, seed: string): boolean {
  if (typed === seed) return true;
  const num = (s: string) => (s.trim() === "" ? NaN : Number(s.replace(/[$,\s]/g, "")));
  const a = num(typed);
  const b = num(seed);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

// Step descriptions come from the model's reasons, which quote this run's inputs; keep PII out of the artifact.
export function templatizeText(text: string, seedParams: Record<string, string>): string {
  let out = text;
  for (const [name, v] of Object.entries(seedParams)) {
    if (v && v.length >= 2) out = out.split(v).join(`{{${name}}}`);
  }
  return out;
}

export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryOutcome> {
  const { goal, page, logger, sessionManager, seedParams, capabilityName } = opts;
  const maxSteps = opts.maxSteps ?? 20;
  const model = opts.model ?? currentModel();
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
  });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  const recordedSteps: Step[] = [];
  const extractedOutputs: Record<string, string> = {};
  let lastSnapshotElements: ElementInfo[] = [];

  messages.push({
    role: "user",
    content: `GOAL: ${goal}\n\nKnown parameters for this run: ${JSON.stringify(seedParams)}\n\nBegin by observing the current page.`,
  });

  for (let turn = 1; turn <= maxSteps; turn++) {
    const snapshot = await captureSnapshot(page);
    lastSnapshotElements = snapshot.elements;
    const observation = `OBSERVATION (turn ${turn}):\n${renderSnapshotForPrompt(snapshot)}`;
    messages.push({ role: "user", content: observation });
    logger.log("agent.observe", { turn, url: snapshot.url });

    const response = await client.chat.completions.create(
      { model, tools: AGENT_TOOLS, tool_choice: "required", messages },
      { timeout: 60_000, maxRetries: 1 }
    );
    const choice = response.choices[0];
    const assistantMessage = choice?.message;
    if (!assistantMessage) throw new Error("Model returned no choices");
    messages.push(assistantMessage);

    const toolCall = assistantMessage.tool_calls?.[0] ?? recoverToolCallFromContent(assistantMessage.content);
    if (!toolCall || toolCall.type !== "function") {
      logger.log("agent.no_tool_call", { turn, text: assistantMessage.content });
      messages.push({
        role: "user",
        content: "You must call exactly one tool. Please call a tool now.",
      });
      continue;
    }

    let input: Record<string, any>;
    try {
      input = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
      input = {};
    }
    logger.log("agent.decide", { turn, tool: toolCall.function.name, input });
    let toolResultText = "OK";

    try {
      switch (toolCall.function.name) {
        case "click": {
          assertActionTypeAllowed("click");
          const el = findElement(lastSnapshotElements, input.ref);
          await clickByElementInfo(page, el);
          assertOriginAllowed(page.url());
          recordedSteps.push({ type: "click", target: el.plan, description: templatizeText(String(input.reason ?? ""), seedParams) });
          toolResultText = `Clicked "${el.name}". Now at ${page.url()}`;
          break;
        }
        case "fill": {
          assertActionTypeAllowed("fill");
          const el = findElement(lastSnapshotElements, input.ref);
          await fillByElementInfo(page, el, String(input.value));
          recordedSteps.push({
            type: "fill",
            target: el.plan,
            valueTemplate: templatize(String(input.value), seedParams),
            description: templatizeText(String(input.reason ?? ""), seedParams),
          });
          toolResultText = `Filled "${el.name}" with "${input.value}".`;
          break;
        }
        case "select_option": {
          assertActionTypeAllowed("selectOption");
          const el = findElement(lastSnapshotElements, input.ref);
          await selectByElementInfo(page, el, String(input.value));
          recordedSteps.push({
            type: "selectOption",
            target: el.plan,
            valueTemplate: templatize(String(input.value), seedParams),
            description: templatizeText(String(input.reason ?? ""), seedParams),
          });
          toolResultText = `Selected "${input.value}" in "${el.name}".`;
          break;
        }
        case "extract_by_label": {
          assertActionTypeAllowed("extract");
          const value = await extractByLabel(page, String(input.label_text));
          extractedOutputs[input.output_name] = value;
          recordedSteps.push({
            type: "extract",
            target: { strategies: [{ kind: "tableCellByRowLabel", labelText: String(input.label_text) }] },
            outputName: input.output_name,
            transform: "trim",
            description: templatizeText(String(input.reason ?? ""), seedParams),
          });
          toolResultText = `Extracted ${input.output_name} = "${value}"`;
          break;
        }
        case "escalate": {
          logger.log("agent.escalate", { turn, reason: input.reason });
          const decision = await sessionManager.requestIntervention({
            kind: "agent",
            capabilityName,
            goal,
            stepIndex: turn,
            reason: input.reason,
          });
          if (decision !== "continue") {
            logger.log("agent.abandoned_by_operator", { turn });
            return {
              success: false,
              summary: `A human operator declined to continue after the agent escalated: ${input.reason}`,
              recordedSteps,
              extractedOutputs,
              stopReason: "escalated_unresolved",
            };
          }
          toolResultText = "A human operator took control and has handed control back. Re-observe and continue.";
          break;
        }
        case "finish": {
          logger.log("agent.finish", { success: input.success, summary: input.summary });
          return {
            success: !!input.success,
            summary: String(input.summary),
            recordedSteps,
            extractedOutputs,
            stopReason: "finished",
          };
        }
        default:
          toolResultText = `Unknown tool ${toolCall.function.name}`;
      }
    } catch (err: any) {
      logger.log("agent.action_error", { turn, tool: toolCall.function.name, error: err.message });
      toolResultText = `Action failed: ${err.message}`;
    }

    messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResultText });
  }

  logger.log("agent.max_steps_reached", { maxSteps });
  return {
    success: false,
    summary: `Stopped after ${maxSteps} steps without a finish() call.`,
    recordedSteps,
    extractedOutputs,
    stopReason: "max_steps",
  };
}

// Some models ignore tool_choice and write the call as JSON in the message text.
function recoverToolCallFromContent(
  content: string | null | undefined
): OpenAI.Chat.Completions.ChatCompletionMessageToolCall | undefined {
  if (!content) return undefined;
  const match = /\{[\s\S]*\}/.exec(content);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]);
    const name = parsed.name ?? parsed.tool;
    const args = parsed.parameters ?? parsed.arguments ?? parsed.input;
    if (typeof name !== "string" || typeof args !== "object") return undefined;
    return {
      id: `recovered_${Date.now()}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
  } catch {
    return undefined;
  }
}

function findElement(elements: ElementInfo[], ref: string): ElementInfo {
  const el = elements.find((e) => e.ref === ref);
  if (!el) throw new Error(`ref ${ref} not found in latest observation`);
  return el;
}

async function locatorFor(page: Page, el: ElementInfo) {
  // Same resolution replay uses, so a recorded plan is known to work.
  const { resolveLocator } = await import("../replay/resolver.js");
  const resolved = await resolveLocator(page, el.plan);
  return resolved.locator;
}

async function clickByElementInfo(page: Page, el: ElementInfo) {
  const locator = await locatorFor(page, el);
  await locator.click();
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

async function fillByElementInfo(page: Page, el: ElementInfo, value: string) {
  const locator = await locatorFor(page, el);
  await locator.fill(value);
}

async function selectByElementInfo(page: Page, el: ElementInfo, value: string) {
  const locator = await locatorFor(page, el);
  await locator.selectOption(value);
}

async function extractByLabel(page: Page, labelText: string): Promise<string> {
  const locator = page
    .locator("tr")
    .filter({ has: page.locator("td", { hasText: labelText }) })
    .locator("td")
    .nth(1);
  return (await locator.textContent())?.trim() ?? "";
}
