import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { chromium, type Browser } from "playwright";
import type { Artifact } from "../artifact/schema.js";

// Exercises the agent-facing API end to end over real HTTP: catalog,
// approval gate, input validation, idempotency, and a full
// escalate -> operator acts -> resume -> agent collects result cycle.

const APP_PORT = 4198;
const TARGET = `http://localhost:${APP_PORT}`;
process.env.TARGET_APP_URL = TARGET;
const artifactsDir = mkdtempSync(path.join(tmpdir(), "artifacts-"));
process.env.ARTIFACTS_DIR = artifactsDir;
process.env.MAX_ACTIVE_RUNS = "2";
process.env.AGENT_API_KEY = "agt_test_key";
process.env.OPERATOR_API_KEY = "op_test_key";
type Who = "agent" | "operator" | null;
const auth = (who: Who): Record<string, string> =>
  who ? { Authorization: `Bearer ${who === "agent" ? "agt_test_key" : "op_test_key"}` } : {};

const approval = { approvedAt: "2026-10-10T00:00:00.000Z", unattendedIrreversible: false, evidence: { runs: 10, confidence: 0.72, mode: "live" as const } };

function base(name: string, risky: boolean, approved: boolean): Artifact {
  return {
    schemaVersion: 1,
    id: name,
    name,
    version: 1,
    description: `${name} test capability`,
    riskLevel: risky ? "risky" : "safe",
    target: { appName: "Meridian Teller Console", allowedOrigin: TARGET, entryPathTemplate: "/members/search" },
    inputParams: [],
    outputs: [],
    successCheckpoint: { kind: "textVisible", text: "x" },
    steps: [],
    provenance: { recordedAt: "", discoveryRunId: "t", model: "t", reviewedBy: approved ? "reviewer" : null, approval: approved ? approval : null },
  };
}

function balance(name: string, approved: boolean): Artifact {
  return {
    ...base(name, false, approved),
    inputParams: [{ name: "memberId", type: "string", description: "member id", required: true, pattern: "^\\d+$" }],
    outputs: [{ name: "savings_balance", type: "string", description: "savings" }],
    successCheckpoint: { kind: "urlMatches", pattern: "/members/\\d+$" },
    steps: [
      { type: "navigate", urlTemplate: "/members/search", description: "search page" },
      { type: "fill", target: { strategies: [{ kind: "formField", name: "memberId" }] }, valueTemplate: "{{memberId}}", description: "id" },
      { type: "click", target: { strategies: [{ kind: "role", role: "button", name: "Look Up Member", exact: true }] }, description: "search" },
      {
        type: "checkOutcomes",
        description: "outcomes",
        outcomes: [{ code: "MEMBER_NOT_FOUND", category: "business_outcome", description: "no such member", detect: { kind: "httpStatus", status: 404 } }],
      },
      { type: "extract", target: { strategies: [{ kind: "tableCellByRowLabel", labelText: "Savings Balance" }] }, outputName: "savings_balance", transform: "trim", description: "read" },
    ],
  };
}

function subaccount(): Artifact {
  return {
    ...base("open_sub", true, true),
    inputParams: [
      { name: "memberId", type: "string", description: "member id", required: true },
      { name: "initialDeposit", type: "string", description: "deposit", required: true },
    ],
    outputs: [{ name: "new_account_number", type: "string", description: "new account" }],
    successCheckpoint: { kind: "textVisible", text: "New Account Number" },
    steps: [
      { type: "navigate", urlTemplate: "/members/{{memberId}}/new-subaccount", description: "form" },
      { type: "fill", target: { strategies: [{ kind: "formField", name: "initialDeposit" }] }, valueTemplate: "{{initialDeposit}}", description: "deposit" },
      { type: "click", target: { strategies: [{ kind: "role", role: "button", name: "Continue", exact: true }] }, description: "continue" },
      { type: "confirmIrreversible", target: { strategies: [{ kind: "role", role: "button", name: "Confirm and Open Account", exact: true }] }, description: "open it" },
      { type: "extract", target: { strategies: [{ kind: "tableCellByRowLabel", labelText: "New Account Number" }] }, outputName: "new_account_number", transform: "trim", description: "read" },
    ],
  };
}

describe("capability server", () => {
  let target: ChildProcess;
  let browser: Browser | undefined;
  let server: Server;
  let api: string;

  const post = (p: string, body: unknown, who: Who = "agent") =>
    fetch(api + p, { method: "POST", headers: { "Content-Type": "application/json", ...auth(who) }, body: JSON.stringify(body) });
  const get = (p: string, who: Who = "agent") => fetch(api + p, { headers: { Accept: "application/json", ...auth(who) }, redirect: "manual" });

  beforeAll(async () => {
    for (const a of [balance("lookup_approved", true), balance("lookup_draft", false), subaccount()]) {
      writeFileSync(path.join(artifactsDir, `${a.name}.v1.json`), JSON.stringify(a));
    }
    // A newer draft of an approved capability: agents must keep getting v1.
    writeFileSync(path.join(artifactsDir, "lookup_approved.v2.json"), JSON.stringify({ ...balance("lookup_approved", false), version: 2 }));
    target = spawn("npx", ["tsx", "src/target-app/server.ts"], { env: { ...process.env, TARGET_APP_PORT: String(APP_PORT) }, stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(`${TARGET}/login`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    // Imported only now, so the modules see the env overrides above.
    const { createCapabilityApp } = await import("./app.js");
    const { app } = createCapabilityApp(async () => (browser ??= await chromium.launch()));
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    api = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  }, 30000);

  afterAll(async () => {
    server?.close();
    await browser?.close();
    target?.kill();
  });

  it("requires credentials, and keeps agents out of everything a person must do", async () => {
    expect((await get("/api/capabilities", null)).status).toBe(401);
    // Browsers without a session are sent to sign in, not shown an error.
    const dash = await fetch(api + "/", { redirect: "manual", headers: { Accept: "text/html" } });
    expect(dash.status).toBe(302);
    expect(dash.headers.get("location")).toContain("/login");
    expect((await get("/", "agent")).status).toBe(403);
    expect((await get("/api/interventions", "agent")).status).toBe(403);
    expect((await get("/api/capabilities?include=drafts", "agent")).status).toBe(403);
    const sup = await post("/api/capabilities/lookup_draft/invoke", { params: { memberId: "12345" }, supervised: true }, "agent");
    expect(sup.status).toBe(403);
    expect((await sup.json()).error).toBe("SUPERVISED_REQUIRES_OPERATOR");
  });

  it("signs an operator in with the operator key, and refuses an agent key at the login page", async () => {
    const asAgent = await fetch(api + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "key=agt_test_key" });
    expect(asAgent.status).toBe(401);
    const asOperator = await fetch(api + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "key=op_test_key" });
    expect(asOperator.status).toBe(302);
    const cookie = asOperator.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    const dash = await fetch(api + "/", { headers: { cookie: cookie.split(";")[0]! } });
    expect(dash.status).toBe(200);
  });

  it("serves agents the newest approved version, not a newer draft", async () => {
    const res = await (await post("/api/capabilities/lookup_approved/invoke", { params: { memberId: "12345" } })).json();
    expect(res.version).toBe(1);
    const ops = (await (await get("/api/capabilities?include=drafts", "operator")).json()) as any[];
    const entry = ops.find((c) => c.name === "lookup_approved");
    expect(entry.version).toBe(2);
    expect(entry.servingVersion).toBe(1);
  }, 30000);

  it("caps concurrent runs and tells the caller when to retry", async () => {
    const a = await (await post("/api/capabilities/open_sub/invoke", { params: { memberId: "12345", initialDeposit: "30.00" } })).json();
    const b = await (await post("/api/capabilities/open_sub/invoke", { params: { memberId: "23456", initialDeposit: "30.00" } })).json();
    expect([a.state, b.state]).toEqual(["AWAITING_HUMAN", "AWAITING_HUMAN"]);
    const third = await post("/api/capabilities/lookup_approved/invoke", { params: { memberId: "12345" } });
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("5");
    for (const r of [a, b]) {
      await post(r.intervention.operatorUrl + "api/resume", { decision: "decline" }, "operator");
      await get(`/api/runs/${r.runId}?wait=terminal`);
    }
    const after = await post("/api/capabilities/lookup_approved/invoke", { params: { memberId: "12345" } });
    expect(after.status).toBe(200);
  }, 60000);

  it("offers agents only approved capabilities, in tool-calling format", async () => {
    const tools = (await (await get(`/api/capabilities?format=openai`)).json()) as any[];
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("lookup_approved");
    expect(names).not.toContain("lookup_draft");
    const lookup = tools.find((t) => t.function.name === "lookup_approved");
    expect(lookup.function.parameters.required).toEqual(["memberId"]);
    expect(lookup.function.description).toContain("MEMBER_NOT_FOUND");
    const sub = tools.find((t) => t.function.name === "open_sub");
    expect(sub.function.description).toContain("pauses for a human");

    const all = (await (await get(`/api/capabilities?include=drafts`, "operator")).json()) as any[];
    expect(all.map((c) => c.name)).toContain("lookup_draft");
  });

  it("refuses to let an agent run a draft", async () => {
    const res = await post("/api/capabilities/lookup_draft/invoke", { params: { memberId: "12345" } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("CAPABILITY_NOT_APPROVED");
  });

  it("rejects malformed input before touching a browser", async () => {
    const unknown = await post("/api/capabilities/lookup_approved/invoke", { params: { memberId: "1", ssn: "x" } });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("UNKNOWN_PARAMS");
    const bad = await post("/api/capabilities/lookup_approved/invoke", { params: { memberId: "abc" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("INVALID_PARAMS");
  });

  it("invokes by name and returns typed outputs or a business outcome", async () => {
    const ok = await post("/api/capabilities/lookup_approved/invoke", { params: { memberId: "12345" } });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.state).toBe("COMPLETED");
    expect(body.result.outputs.savings_balance).toBe("$4,823.10");

    const missing = await (await post("/api/capabilities/lookup_approved/invoke", { params: { memberId: "99999" } })).json();
    expect(missing.state).toBe("BUSINESS_OUTCOME");
    expect(missing.result.code).toBe("MEMBER_NOT_FOUND");
  }, 30000);

  it("returns the original run for a retried idempotency key, and rejects key reuse with different input", async () => {
    const first = await (await post("/api/capabilities/lookup_approved/invoke", { params: { memberId: "23456" }, idempotencyKey: "abc-1" })).json();
    const retry = await (await post("/api/capabilities/lookup_approved/invoke", { params: { memberId: "23456" }, idempotencyKey: "abc-1" })).json();
    expect(retry.runId).toBe(first.runId);
    expect(retry.idempotent).toBe(true);
    const conflict = await post("/api/capabilities/lookup_approved/invoke", { params: { memberId: "12345" }, idempotencyKey: "abc-1" });
    expect(conflict.status).toBe(409);
  }, 30000);

  it("pauses an irreversible call for a human, who takes over the same session and hands back control", async () => {
    const res = await post("/api/capabilities/open_sub/invoke", { params: { memberId: "12345", initialDeposit: "55.00" } });
    expect(res.status).toBe(202);
    const paused = await res.json();
    expect(paused.state).toBe("AWAITING_HUMAN");
    expect(paused.intervention.kind).toBe("policy");

    const inbox = (await (await get(`/api/interventions`, "operator")).json()) as any[];
    expect(inbox.map((i) => i.runId)).toContain(paused.runId);

    // The agent cannot confirm its own irreversible action.
    expect((await post(paused.intervention.operatorUrl + "api/resume", {}, "agent")).status).toBe(403);

    const state = await (await get(paused.intervention.operatorUrl + "api/state", "operator")).json();
    const confirm = state.elements.find((e: any) => e.name === "Confirm and Open Account");
    expect((await post(paused.intervention.operatorUrl + "api/act", { ref: confirm.ref, type: "click" }, "operator")).ok).toBe(true);
    expect((await post(paused.intervention.operatorUrl + "api/resume", {}, "operator")).ok).toBe(true);

    const done = await (await get(`/api/runs/${paused.runId}?wait=terminal`)).json();
    expect(done.state).toBe("COMPLETED");
    expect(done.result.outputs.new_account_number).toMatch(/^9\d{5}$/);
    expect(done.record.transitions.map((t: any) => t.to)).toEqual(["INITIALIZED", "RUNNING", "AWAITING_HUMAN", "RUNNING", "COMPLETED"]);
  }, 40000);
});
