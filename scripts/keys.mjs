import { existsSync, readFileSync } from "node:fs";

export function readKeys() {
  if (process.env.AGENT_API_KEY && process.env.OPERATOR_API_KEY) {
    return { agent: process.env.AGENT_API_KEY, operator: process.env.OPERATOR_API_KEY };
  }
  if (!existsSync(".keys.json")) {
    throw new Error("No keys found. Start the capability server once (`npm run server`); it writes .keys.json.");
  }
  return JSON.parse(readFileSync(".keys.json", "utf-8"));
}

export const bearer = (key) => ({ Authorization: `Bearer ${key}` });
