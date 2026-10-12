import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { replay } from "./engine.js";
import { RunLogger } from "../logging/logger.js";
import { SessionManager } from "../escalation/session-manager.js";
import { RunTracker } from "../runs/tracker.js";
import type { Artifact } from "../artifact/schema.js";

const PORT = 4199;
const BASE_URL = `http://localhost:${PORT}`;

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE_URL}/login`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("target-app did not start in time");
}

// A hand-authored artifact equivalent to what `capabilities/definitions.ts`
// would produce for `lookup_member_balance` after augmentation. Built
// directly here so the replay engine is exercised without requiring an LLM.
function balanceArtifact(): Artifact {
  return {
    schemaVersion: 1,
    id: "test-artifact",
    name: "lookup_member_balance",
    version: 1,
    description: "test",
    riskLevel: "safe",
    target: { appName: "Meridian Teller Console", allowedOrigin: BASE_URL, entryPathTemplate: "/members/search" },
    inputParams: [{ name: "memberId", type: "string", description: "member id", required: true }],
    outputs: [
      { name: "savings_balance", type: "string", description: "savings" },
      { name: "checking_balance", type: "string", description: "checking" },
    ],
    successCheckpoint: { kind: "urlMatches", pattern: `^${BASE_URL}/members/[^/]+$` },
    steps: [
      { type: "navigate", urlTemplate: "/members/search", description: "go to search" },
      { type: "fill", target: { strategies: [{ kind: "formField", name: "memberId" }] }, valueTemplate: "{{memberId}}", description: "type member id" },
      {
        type: "click",
        target: { strategies: [{ kind: "role", role: "button", name: "Look Up Member", exact: true }] },
        description: "submit search",
      },
      {
        type: "checkOutcomes",
        description: "handle non-happy-path outcomes",
        outcomes: [
          { code: "MEMBER_NOT_FOUND", category: "business_outcome", description: "no such member", detect: { kind: "httpStatus", status: 404 } },
          { code: "PERMISSION_DENIED", category: "business_outcome", description: "restricted", detect: { kind: "httpStatus", status: 403 } },
          {
            code: "CORE_TIMEOUT",
            category: "recoverable",
            description: "transient",
            detect: { kind: "httpStatus", status: 504 },
            recovery: { action: "reload", maxAttempts: 2, waitMs: 300 },
          },
        ],
      },
      {
        type: "extract",
        target: { strategies: [{ kind: "tableCellByRowLabel", labelText: "Savings Balance" }] },
        outputName: "savings_balance",
        transform: "trim",
        description: "read savings",
      },
      {
        type: "extract",
        target: { strategies: [{ kind: "tableCellByRowLabel", labelText: "Checking Balance" }] },
        outputName: "checking_balance",
        transform: "trim",
        description: "read checking",
      },
    ],
    provenance: { recordedAt: new Date().toISOString(), discoveryRunId: "test", model: "test", reviewedBy: null, approval: null },
  };
}

// The risky flow: an irreversible confirm step, as `capabilities/definitions.ts`
// would produce it for `open_member_subaccount`.
function subAccountArtifact(approval: Artifact["provenance"]["approval"] = null): Artifact {
  return {
    schemaVersion: 1,
    id: "test-subaccount",
    name: "open_member_subaccount",
    version: 1,
    description: "test",
    riskLevel: "risky",
    target: { appName: "Meridian Teller Console", allowedOrigin: BASE_URL, entryPathTemplate: "/members/search" },
    inputParams: [
      { name: "memberId", type: "string", description: "member id", required: true },
      { name: "initialDeposit", type: "string", description: "deposit", required: true },
    ],
    outputs: [{ name: "new_account_number", type: "string", description: "new account" }],
    successCheckpoint: { kind: "textVisible", text: "New Account Number" },
    steps: [
      { type: "navigate", urlTemplate: "/members/{{memberId}}/new-subaccount", description: "open form" },
      { type: "fill", target: { strategies: [{ kind: "formField", name: "initialDeposit" }] }, valueTemplate: "{{initialDeposit}}", description: "deposit" },
      { type: "click", target: { strategies: [{ kind: "role", role: "button", name: "Continue", exact: true }] }, description: "continue" },
      {
        type: "checkOutcomes",
        description: "validation",
        outcomes: [
          { code: "VALIDATION_ERROR", category: "business_outcome", description: "too small", detect: { kind: "httpStatus", status: 422 } },
          {
            code: "SUPERVISOR_OVERRIDE",
            category: "recoverable",
            description: "needs a supervisor",
            detect: { kind: "textVisible", text: "Supervisor override required" },
            recovery: { action: "human", instruction: "Supervisor enters PIN", maxAttempts: 1, waitMs: 0 },
          },
        ],
      },
      {
        type: "confirmIrreversible",
        target: { strategies: [{ kind: "role", role: "button", name: "Confirm and Open Account", exact: true }] },
        description: "open the account",
      },
      {
        type: "extract",
        target: { strategies: [{ kind: "tableCellByRowLabel", labelText: "New Account Number" }] },
        outputName: "new_account_number",
        transform: "trim",
        description: "read account number",
      },
    ],
    provenance: { recordedAt: new Date().toISOString(), discoveryRunId: "test", model: "test", reviewedBy: approval ? "test-reviewer" : null, approval },
  };
}

describe("replay engine against the live target app", () => {
  let serverProc: ChildProcess;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    serverProc = spawn("npx", ["tsx", "src/target-app/server.ts"], {
      env: { ...process.env, TARGET_APP_PORT: String(PORT) },
      stdio: "ignore",
    });
    await waitForServer();
    browser = await chromium.launch();
  }, 30000);

  afterAll(async () => {
    await browser.close();
    serverProc.kill();
  });

  async function freshLoggedInPage(): Promise<Page> {
    context = await browser.newContext();
    const p = await context.newPage();
    await p.goto(`${BASE_URL}/login`);
    await p.fill('input[name="username"]', "teller1");
    await p.fill('input[name="password"]', "demo");
    await p.click('input[type="submit"]');
    await p.waitForLoadState("networkidle");
    return p;
  }

  it("succeeds and extracts typed outputs for a real member", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-success", "replay");
    const result = await replay(balanceArtifact(), { memberId: "12345" }, { page, logger });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs.savings_balance).toBe("$4,823.10");
      expect(result.outputs.checking_balance).toBe("$1,210.55");
    }
    await context.close();
  });

  it("reports MEMBER_NOT_FOUND as a business outcome, not a crash", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-notfound", "replay");
    const result = await replay(balanceArtifact(), { memberId: "99999" }, { page, logger });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") expect(result.code).toBe("MEMBER_NOT_FOUND");
    await context.close();
  });

  it("reports PERMISSION_DENIED as a business outcome for a restricted member", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-denied", "replay");
    const result = await replay(balanceArtifact(), { memberId: "40000" }, { page, logger });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") expect(result.code).toBe("PERMISSION_DENIED");
    await context.close();
  });

  it("recovers from a transient timeout via retry and still succeeds", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-flaky", "replay");
    const result = await replay(balanceArtifact(), { memberId: "50000" }, { page, logger });
    expect(result.status).toBe("success");
    await context.close();
  });

  it("escalates to a human when automated retries are exhausted, and continues once resolved", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-escalate-recovery", "replay");
    const sessionManager = new SessionManager(page, logger);

    // No automated retry budget at all, so the very first match escalates
    // immediately instead of looping - keeps the test fast and deterministic.
    const artifact = balanceArtifact();
    const outcomesStep = artifact.steps.find((s) => s.type === "checkOutcomes");
    if (outcomesStep?.type === "checkOutcomes") {
      const timeout = outcomesStep.outcomes.find((o) => o.code === "CORE_TIMEOUT");
      if (timeout) timeout.recovery = { action: "reload", maxAttempts: 0, waitMs: 0 };
    }

    const replayPromise = replay(artifact, { memberId: "50001" }, { page, logger, sessionManager });

    // Stand in for a human: wait for the escalation, "fix" it the same way
    // reloading the page would (the target app's flakiness is one-time), and
    // resume - exactly what clicking through the operator console does.
    for (let i = 0; i < 50 && !sessionManager.getOpenRequest(); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const openRequest = sessionManager.getOpenRequest();
    expect(openRequest).toBeDefined();
    expect(openRequest?.reason).toContain("CORE_TIMEOUT");
    await page.reload();
    sessionManager.resume();

    const result = await replayPromise;
    expect(result.status).toBe("success");
    await context.close();
  });

  it("rehearsal stops before the irreversible step without performing it", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-rehearsal", "replay");
    const result = await replay(subAccountArtifact(), { memberId: "12345", initialDeposit: "40.00" }, { page, logger, mode: "rehearsal" });
    expect(result.status).toBe("rehearsal_complete");
    if (result.status === "rehearsal_complete") expect(result.stoppedBeforeStep).toBe(4);
    // Still on the confirmation screen: nothing was opened.
    expect(await page.getByRole("button", { name: "Confirm and Open Account" }).count()).toBe(1);
    expect(await page.getByText("New Account Number").count()).toBe(0);
    await context.close();
  });

  it("pauses a draft's irreversible step for a human, tracks the handoff, and finishes on the same session", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-policy-pause", "replay");
    const sessionManager = new SessionManager(page, logger);
    const tracker = new RunTracker(
      { runId: logger.runId, kind: "replay", capability: "open_member_subaccount", version: 1, mode: "live", invokedBy: "cli", params: {} },
      logger
    );

    const replayPromise = replay(subAccountArtifact(), { memberId: "12345", initialDeposit: "40.00" }, { page, logger, sessionManager });
    for (let i = 0; i < 50 && !sessionManager.getOpenRequest(); i++) await new Promise((r) => setTimeout(r, 100));
    const open = sessionManager.getOpenRequest();
    expect(open?.kind).toBe("policy");
    expect(tracker.record.state).toBe("AWAITING_HUMAN");
    expect(tracker.record.controller).toBe("human");

    // The human confirms through the same handle-based path the operator console uses.
    const confirm = sessionManager.getSnapshot()!.elements.find((e) => e.name === "Confirm and Open Account")!;
    await sessionManager.performHumanAction({ ref: confirm.ref, type: "click" });
    sessionManager.resume();

    const result = await replayPromise;
    tracker.finishReplay(result);
    expect(result.status).toBe("success");
    if (result.status === "success") expect(String(result.outputs.new_account_number)).toMatch(/^9\d{5}$/);
    expect(tracker.record.transitions.map((t) => t.to)).toEqual(["INITIALIZED", "RUNNING", "AWAITING_HUMAN", "RUNNING", "COMPLETED"]);
    expect(tracker.record.interventions[0]?.humanActions).toBe(1);
    await context.close();
  });

  // Regression test for a real session: an operator opened the console and
  // clicked Resume without clicking Confirm. That used to surface as a
  // confusing LOCATOR_NOT_FOUND on the following step.
  it("reports DECLINED_BY_OPERATOR when control comes back without the irreversible step confirmed", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-resume-unconfirmed", "replay");
    const sessionManager = new SessionManager(page, logger);
    const run = replay(subAccountArtifact(), { memberId: "12345", initialDeposit: "40.00" }, { page, logger, sessionManager });
    for (let i = 0; i < 50 && !sessionManager.getOpenRequest(); i++) await new Promise((r) => setTimeout(r, 100));
    sessionManager.resume("continue");
    const result = await run;
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") expect(result.code).toBe("DECLINED_BY_OPERATOR");
    await context.close();
  });

  it("stops with DECLINED_BY_OPERATOR on an explicit decline, without performing the action", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-decline", "replay");
    const sessionManager = new SessionManager(page, logger);
    const run = replay(subAccountArtifact(), { memberId: "12345", initialDeposit: "40.00" }, { page, logger, sessionManager });
    for (let i = 0; i < 50 && !sessionManager.getOpenRequest(); i++) await new Promise((r) => setTimeout(r, 100));
    sessionManager.resume("decline");
    const result = await run;
    expect(result.status === "business_outcome" && result.code).toBe("DECLINED_BY_OPERATOR");
    expect(await page.getByText("New Account Number").count()).toBe(0);
    await context.close();
  });

  it("hands a step only a person may do (a supervisor PIN) to a human, never records the PIN, then still asks for confirmation", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-human-task", "replay");
    const sessionManager = new SessionManager(page, logger);
    const tracker = new RunTracker(
      { runId: logger.runId, kind: "replay", capability: "open_member_subaccount", version: 1, mode: "live", invokedBy: "cli", params: {} },
      logger
    );
    const run = replay(subAccountArtifact(), { memberId: "23456", initialDeposit: "15000.00" }, { page, logger, sessionManager });

    // 1st pause: the supervisor override - a "task", not a confirmation.
    for (let i = 0; i < 50 && !sessionManager.getOpenRequest(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(sessionManager.getOpenRequest()?.kind).toBe("task");
    const els = sessionManager.getSnapshot()!.elements;
    await sessionManager.performHumanAction({ ref: els.find((e) => e.name === "Supervisor PIN")!.ref, type: "fill", value: "2468" });
    await sessionManager.performHumanAction({ ref: sessionManager.getSnapshot()!.elements.find((e) => e.name === "Approve Override")!.ref, type: "click" });
    sessionManager.resume("continue");

    // 2nd pause: the irreversible step itself still needs confirming.
    for (let i = 0; i < 50 && sessionManager.getOpenRequest()?.kind !== "policy"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(sessionManager.getOpenRequest()?.kind).toBe("policy");
    await sessionManager.performHumanAction({ ref: sessionManager.getSnapshot()!.elements.find((e) => e.name === "Confirm and Open Account")!.ref, type: "click" });
    sessionManager.resume("continue");

    const result = await run;
    tracker.finishReplay(result);
    expect(result.status).toBe("success");
    expect(tracker.record.interventions.map((i) => i.kind)).toEqual(["task", "policy"]);
    const log = readFileSync(path.join(logger.runDir, "log.jsonl"), "utf-8");
    expect(log).not.toContain("2468");
    expect(log).toContain("[REDACTED]");
    await context.close();
  });

  it("reports DECLINED_BY_OPERATOR when the supervisor refuses the override", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-human-task-declined", "replay");
    const sessionManager = new SessionManager(page, logger);
    const run = replay(subAccountArtifact(), { memberId: "23456", initialDeposit: "15000.00" }, { page, logger, sessionManager });
    for (let i = 0; i < 50 && !sessionManager.getOpenRequest(); i++) await new Promise((r) => setTimeout(r, 100));
    sessionManager.resume("decline");
    const result = await run;
    expect(result.status === "business_outcome" && result.code).toBe("DECLINED_BY_OPERATOR");
    await context.close();
  });

  it("fails with HUMAN_TASK_INCOMPLETE if control comes back but the step wasn't done", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-human-task-incomplete", "replay");
    const sessionManager = new SessionManager(page, logger);
    const run = replay(subAccountArtifact(), { memberId: "23456", initialDeposit: "15000.00" }, { page, logger, sessionManager });
    for (let i = 0; i < 50 && !sessionManager.getOpenRequest(); i++) await new Promise((r) => setTimeout(r, 100));
    sessionManager.resume("continue");
    const result = await run;
    expect(result.status === "failure" && result.errorCode).toBe("HUMAN_TASK_INCOMPLETE");
    await context.close();
  });

  it("never asks a person to confirm a control that isn't on screen", async () => {
    // An artifact without the override check meets the override page: the
    // irreversible step fails cleanly instead of pausing a human on it.
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-confirm-precheck", "replay");
    const sessionManager = new SessionManager(page, logger);
    const artifact = subAccountArtifact();
    const check = artifact.steps.find((s) => s.type === "checkOutcomes");
    if (check?.type === "checkOutcomes") check.outcomes = check.outcomes.filter((o) => o.code !== "SUPERVISOR_OVERRIDE");
    const result = await replay(artifact, { memberId: "23456", initialDeposit: "15000.00" }, { page, logger, sessionManager });
    expect(result.status === "failure" && result.errorCode).toBe("LOCATOR_NOT_FOUND");
    expect(sessionManager.getOpenRequest()).toBeUndefined();
    await context.close();
  });

  it("times out cleanly when nobody answers, without performing the irreversible step", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-timeout", "replay");
    const sessionManager = new SessionManager(page, logger, { timeoutMs: 600 });
    const result = await replay(subAccountArtifact(), { memberId: "12345", initialDeposit: "40.00" }, { page, logger, sessionManager });
    expect(result.status === "failure" && result.errorCode).toBe("OPERATOR_TIMEOUT");
    expect(await page.getByText("New Account Number").count()).toBe(0);
    await context.close();
  });

  it("trusts the page over the hand-back: confirmed on screen but never resumed still counts as done", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-confirmed-then-timeout", "replay");
    const sessionManager = new SessionManager(page, logger, { timeoutMs: 2500 });
    const run = replay(subAccountArtifact(), { memberId: "12345", initialDeposit: "40.00" }, { page, logger, sessionManager });
    for (let i = 0; i < 50 && !sessionManager.getOpenRequest(); i++) await new Promise((r) => setTimeout(r, 100));
    const confirm = sessionManager.getSnapshot()!.elements.find((e) => e.name === "Confirm and Open Account")!;
    await sessionManager.performHumanAction({ ref: confirm.ref, type: "click" });
    const result = await run; // the operator never presses Resume
    expect(result.status).toBe("success");
    await context.close();
  });

  it("auto-confirms only when a reviewer explicitly approved unattended irreversible execution", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-auto-confirm", "replay");
    const approval = { approvedAt: new Date().toISOString(), unattendedIrreversible: true, evidence: { runs: 10, confidence: 0.72, mode: "live" as const } };
    const result = await replay(subAccountArtifact(approval), { memberId: "23456", initialDeposit: "30.00" }, { page, logger });
    expect(result.status).toBe("success");
    await context.close();
  });

  it("fails with a clear, structured error when a required param is missing", async () => {
    page = await freshLoggedInPage();
    const logger = new RunLogger("test-invalid", "replay");
    const result = await replay(balanceArtifact(), {}, { page, logger });
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.errorCode).toBe("INVALID_PARAMS");
    await context.close();
  });
});
