// npm run api-walkthrough  (needs the target app and `npm run server`)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readKeys, bearer } from "./keys.mjs";

const API = process.env.CAPABILITY_API ?? "http://localhost:4180";
const KEYS = readKeys();
const lines = [];
const log = (s = "") => {
  console.log(s);
  lines.push(s);
};
const mask = (s) => String(s).replace(/\b\d{5,12}\b/g, (m) => "*".repeat(m.length - 4) + m.slice(-4));
const show = (obj) => mask(JSON.stringify(obj, null, 2));

async function call(method, p, body, role = "agent") {
  const res = await fetch(API + p, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(role ? bearer(KEYS[role]) : {}), Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function operator(decision) {
  const inbox = (await call("GET", "/api/interventions", undefined, "operator")).body;
  const item = inbox[0];
  const base = item.operatorUrl;
  if (decision === "continue") {
    const state = (await call("GET", `${base}api/state`, undefined, "operator")).body;
    const confirm = state.elements.find((e) => e.name === "Confirm and Open Account");
    await call("POST", `${base}api/act`, { ref: confirm.ref, type: "click" }, "operator");
  }
  await call("POST", `${base}api/resume`, { decision }, "operator");
  return item;
}

log("# Agent API walkthrough");
log("");
log(`Against \`${API}\`, ${new Date().toISOString()}. Member IDs and account numbers are masked.`);

log("\n## 1. Discover: what an agent is offered (`GET /api/capabilities?format=openai`)\n");
const tools = (await call("GET", "/api/capabilities?format=openai")).body;
log("```json\n" + show(tools) + "\n```");

log("\n## 2. Invoke by name with typed args: `lookup_member_balance`\n");
let r = await call("POST", "/api/capabilities/lookup_member_balance/invoke", { params: { memberId: "12345" }, idempotencyKey: "walkthrough-1" });
log(`HTTP ${r.status}, state **${r.body.state}**`);
log("```json\n" + show(r.body.result) + "\n```");
const firstRun = r.body.runId;

log("\n## 3. A business outcome is an answer, not an error\n");
r = await call("POST", "/api/capabilities/lookup_member_balance/invoke", { params: { memberId: "99999" } });
log(`HTTP ${r.status}, state **${r.body.state}**: \`${show(r.body.result)}\``);

log("\n## 4. Retrying with the same idempotency key returns the original run\n");
r = await call("POST", "/api/capabilities/lookup_member_balance/invoke", { params: { memberId: "12345" }, idempotencyKey: "walkthrough-1" });
log(`HTTP ${r.status}, runId ${r.body.runId} (original ${firstRun}), idempotent=${r.body.idempotent}`);
r = await call("POST", "/api/capabilities/lookup_member_balance/invoke", { params: { memberId: "23456" }, idempotencyKey: "walkthrough-1" });
log(`Same key, different input: HTTP ${r.status} \`${r.body.error}\``);

log("\n## 5. Bad input is rejected before a browser is touched\n");
r = await call("POST", "/api/capabilities/lookup_member_balance/invoke", { params: { memberId: "abc" } });
log(`\`memberId: "abc"\` -> HTTP ${r.status} \`${r.body.error}\`: ${r.body.message}`);
r = await call("POST", "/api/capabilities/lookup_member_balance/invoke", { params: { memberId: "12345", ssn: "123-45-6789" } });
log(`unexpected \`ssn\` field -> HTTP ${r.status} \`${r.body.error}\``);

log("\n## 6. Irreversible action: pauses for a human, who confirms on the live session\n");
r = await call("POST", "/api/capabilities/open_member_subaccount/invoke", { params: { memberId: "23456", initialDeposit: "40.00" }, idempotencyKey: "walkthrough-open-1" });
log(`HTTP ${r.status}, state **${r.body.state}**, intervention: ${show(r.body.intervention)}`);
const confirmRun = r.body.runId;

log("\nWhile it waits, separation of duties is enforced:\n");
const op = r.body.intervention.operatorUrl;
let s = await call("POST", `${op}api/resume`, { decision: "continue" }, "agent");
log(`- The **agent** tries to approve its own irreversible action (\`POST ${op}api/resume\`): HTTP ${s.status} \`${s.body.error}\``);
s = await call("POST", "/api/capabilities/open_member_subaccount/invoke", { params: { memberId: "23456", initialDeposit: "40.00" }, supervised: true }, "agent");
log(`- The **agent** tries to start a "supervised" run to get around the approval gate: HTTP ${s.status} \`${s.body.error}\``);
s = await call("GET", "/api/capabilities?format=openai", undefined, null);
log(`- No key at all: HTTP ${s.status} \`${s.body.error}\``);
log("");

const confirmed = await operator("continue");
log(`Operator (at ${confirmed.operatorUrl}) clicked "Confirm and Open Account" and resumed.`);
r = await call("GET", `/api/runs/${confirmRun}?wait=terminal`);
log(`Agent polls \`GET /api/runs/${confirmRun}?wait=terminal\` -> state **${r.body.state}**`);
log("```json\n" + show(r.body.result) + "\n```");
log(`State transitions: ${r.body.record.transitions.map((t) => t.to).join(" -> ")}`);

log("\n## 7. Same capability, operator declines\n");
r = await call("POST", "/api/capabilities/open_member_subaccount/invoke", { params: { memberId: "12345", initialDeposit: "40.00" } });
log(`HTTP ${r.status}, state **${r.body.state}**`);
const declineRun = r.body.runId;
await operator("decline");
r = await call("GET", `/api/runs/${declineRun}?wait=terminal`);
log(`After decline -> state **${r.body.state}**: \`${show(r.body.result)}\``);

const dir = path.join(process.cwd(), "evidence", `api-walkthrough-${Date.now().toString(36)}`);
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "walkthrough.md"), lines.join("\n") + "\n");
console.log(`\nWritten to ${dir}/walkthrough.md`);
