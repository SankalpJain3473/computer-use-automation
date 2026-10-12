import type OpenAI from "openai";

export const AGENT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "click",
      description: "Click an interactive element identified by its ref from the latest OBSERVATION.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: 'Element ref, e.g. "e3"' },
          reason: { type: "string", description: "Why this click moves toward the goal" },
        },
        required: ["ref", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fill",
      description: "Type a value into a text/textbox element identified by its ref.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          value: { type: "string" },
          reason: { type: "string" },
        },
        required: ["ref", "value", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select_option",
      description: "Choose an option (by its value or label) in a <select> element identified by ref.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          value: { type: "string" },
          reason: { type: "string" },
        },
        required: ["ref", "value", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_by_label",
      description:
        "Read a labeled value from the page (e.g. a table row like 'Savings Balance'). Use this to capture data the capability should return to its caller.",
      parameters: {
        type: "object",
        properties: {
          label_text: { type: "string", description: 'Exact or near-exact row label, e.g. "Savings Balance"' },
          output_name: { type: "string", description: "snake_case name for this output" },
          reason: { type: "string" },
        },
        required: ["label_text", "output_name", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate",
      description:
        "Stop and hand control to a human operator because you cannot safely or confidently proceed (ambiguous state, unexpected error, action outside your permitted scope).",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Declare the goal reached (or definitively unreachable) and stop the loop.",
      parameters: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          summary: { type: "string" },
        },
        required: ["success", "summary"],
      },
    },
  },
];

export const SYSTEM_PROMPT = `You are an automation agent operating a real internal banking back-office web application on behalf of a bank teller. You do not have API access - the only way to accomplish anything is by reading the rendered page and clicking/typing exactly like a human operator would.

Rules:
- Call exactly one tool per turn. Always call a tool - never reply with plain text.
- Only act on elements shown in the latest OBSERVATION using their exact ref.
- Never invent data. If a value is not visible, look for it before guessing.
- If the page shows an error, an unexpected state, or you are not confident what to do, call "escalate" rather than guessing at a financial-data screen.
- When the goal is fully and verifiably reached, call "finish" with success=true and a summary of what you confirmed on screen.
- If you determine the goal cannot be reached (e.g. a definitive error state), call "finish" with success=false and explain why - this is a legitimate outcome, not something to hide.`;
