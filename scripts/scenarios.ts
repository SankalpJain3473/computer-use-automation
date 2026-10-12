// npm run scenarios  (needs the target app). Writes evidence/scenarios-<time>/README.md; exits 1 on any mismatch.
try {
  process.loadEnvFile();
} catch {
  /* fine */
}

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { chromium, type Browser } from "playwright";
import { loadArtifact } from "../src/artifact/store.js";
import type { Artifact } from "../src/artifact/schema.js";
import { assertContract, ArtifactContractError } from "../src/artifact/validate.js";
import { evidenceRoot } from "../src/logging/logger.js";
import type { ReplayResult } from "../src/replay/results.js";
import { startReplayRun, type StartedRun } from "../src/runs/executor.js";
import { approveArtifact, ApprovalRefused } from "../src/runs/approval.js";
import { createCapabilityApp } from "../src/server/app.js";
import { BASE_URL } from "../src/target-app-client.js";

type Category =
  | "Success"
  | "Business outcome"
  | "Recoverable"
  | "Hard failure"
  | "Human handoff"
  | "Guardrail"
  | "Agent API"
  | "Lifecycle";

interface Outcome {
  actual: string;
  ok: boolean;
  notes: string[];
  evidence?: string;
}

interface Scenario {
  id: string;
  category: Category;
  title: string;
  input: string;
  expected: string;
  why: string;
  run: () => Promise<Outcome>;
}

const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = path.join(evidenceRoot(), `scenarios-${STAMP}`);
mkdirSync(OUT, { recursive: true });

let browser: Browser;
const latest = (name: string) => loadArtifact(name);


function summarize(result: ReplayResult | undefined): string {
  if (!result) return "harness error";
  if (result.status === "business_outcome") return `business_outcome:${result.code}`;
  if (result.status === "failure") return `failure:${result.errorCode}`;
  return result.status;
}

function events(run: StartedRun): { event: string; [k: string]: unknown }[] {
  return readFileSync(path.join(run.tracker.record.evidenceDir, "log.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function replayCase(
  id: string,
  artifact: Artifact,
  params: Record<string, string>,
  opts: { mode?: "live" | "rehearsal"; operator?: (run: StartedRun) => Promise<void>; timeoutMs?: number } = {}
) {
  const run = await startReplayRun({
    browser,
    artifact,
    params,
    mode: opts.mode,
    interventionTimeoutMs: opts.timeoutMs,
    invokedBy: "scenario",
    logDir: path.join(OUT, id),
    quiet: true,
  });
  if (opts.operator) await opts.operator(run);
  const result = await run.done;
  return { run, result, evidence: path.join(path.basename(OUT), id) };
}

async function waitForHuman(run: StartedRun, kind?: string): Promise<void> {
  const ready = () => {
    const open = run.sessionManager.getOpenRequest();
    return !!open && (!kind || open.kind === kind);
  };
  for (let i = 0; i < 150 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!ready()) throw new Error(`run never paused for a human${kind ? ` (${kind})` : ""}`);
}

async function humanFills(run: StartedRun, fieldName: string, value: string): Promise<void> {
  await run.sessionManager.refreshSnapshot();
  const el = run.sessionManager.getSnapshot()?.elements.find((e) => e.name === fieldName);
  if (!el) throw new Error(`no "${fieldName}" field on the paused page`);
  await run.sessionManager.performHumanAction({ ref: el.ref, type: "fill", value });
}

async function humanClicks(run: StartedRun, controlName: string): Promise<void> {
  await run.sessionManager.refreshSnapshot();
  const el = run.sessionManager.getSnapshot()?.elements.find((e) => e.name === controlName);
  if (!el) throw new Error(`no "${controlName}" control on the paused page`);
  await run.sessionManager.performHumanAction({ ref: el.ref, type: "click" });
}

async function setSkin(skin: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/debug/skin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skin }) });
  if (!res.ok) throw new Error(`could not switch the target app to ${skin}`);
}

const mask = (s: string) => s.replace(/\b\d{5,12}\b/g, (m) => "*".repeat(m.length - 4) + m.slice(-4));

function expectEq(actual: string, expected: string, notes: string[], evidence?: string, extra = true): Outcome {
  return { actual, ok: actual === expected && extra, notes, evidence };
}

function failureNotes(result: ReplayResult | undefined): string[] {
  if (result?.status !== "failure") return [];
  return [
    `failed at step ${result.stepIndex} (${result.stepDescription})`,
    `expected: ${result.expected}`,
    `observed: ${mask(result.observed).slice(0, 220)}`,
  ];
}


function scenarios(): Scenario[] {
  const lookup = latest("lookup_member_balance");
  const sub = latest("open_member_subaccount");
  const hasInterstitialCheck = JSON.stringify(lookup.steps).includes("COMPLIANCE_NOTICE");

  return [
    {
      id: "01-happy-path",
      category: "Success",
      title: "Look up a member and return typed outputs",
      input: "lookup_member_balance, member 12345",
      expected: "success",
      why: "The production path: a recorded flow replayed with new inputs, no LLM, outputs returned to the caller.",
      run: async () => {
        const { result, evidence } = await replayCase("01-happy-path", lookup, { memberId: "12345" });
        const notes = result?.status === "success" ? [`outputs: ${JSON.stringify(result.outputs)}`] : failureNotes(result);
        return expectEq(summarize(result), "success", notes, evidence);
      },
    },
    {
      id: "02-drift-absorbed",
      category: "Success",
      title: "Another tenant renamed a button; a fallback locator still finds it",
      input: 'member 12345 on tenant B ("Look Up Member" button relabelled "Find Member")',
      expected: "success",
      why: "Same vendor product, different configuration. The ranked locator plan falls back from role+name to the recorded position, and the drift is recorded rather than hidden.",
      run: async () => {
        await setSkin("tenant-b");
        try {
          const { run, result, evidence } = await replayCase("02-drift-absorbed", lookup, { memberId: "12345" });
          const drift = run.tracker.record.steps.filter((s) => s.driftStrategyIndex !== undefined);
          const notes = drift.map((s) => `drift recorded: step ${s.index} (${s.type}) resolved by fallback strategy #${s.driftStrategyIndex}`);
          return expectEq(summarize(result), "success", notes.length ? notes : ["no drift recorded (unexpected)"], evidence, drift.length > 0);
        } finally {
          await setSkin("standard");
        }
      },
    },
    {
      id: "03-irreversible-confirmed",
      category: "Human handoff",
      title: "Irreversible step: a human confirms on the live session",
      input: "open_member_subaccount, member 12345, $40.00",
      expected: "success",
      why: "An unattended agent must not open accounts by itself. Replay pauses, the operator confirms on the very same page, and automation finishes the flow.",
      run: async () => {
        const { run, result, evidence } = await replayCase("03-irreversible-confirmed", sub, { memberId: "12345", initialDeposit: "40.00" }, {
          operator: async (r) => {
            await waitForHuman(r);
            await humanClicks(r, "Confirm and Open Account");
            r.sessionManager.resume("continue");
          },
        });
        const rec = run.tracker.record;
        return expectEq(summarize(result), "success", [
          `transitions: ${rec.transitions.map((t) => t.to).join(" → ")}`,
          `human actions recorded: ${rec.interventions[0]?.humanActions ?? 0}`,
        ], evidence);
      },
    },
    {
      id: "04-rehearsal",
      category: "Success",
      title: "Rehearsal: exercise a risky flow without doing the irreversible thing",
      input: "open_member_subaccount in rehearsal mode",
      expected: "rehearsal_complete",
      why: "How a risky capability earns approval evidence without opening real accounts: run up to the irreversible step, prove its control resolves, stop.",
      run: async () => {
        const { result, evidence } = await replayCase("04-rehearsal", sub, { memberId: "12345", initialDeposit: "40.00" }, { mode: "rehearsal" });
        const notes = result?.status === "rehearsal_complete" ? [`stopped before step ${result.stoppedBeforeStep}; confirm control resolved via strategy #${result.confirmTargetStrategy}`] : [];
        return expectEq(summarize(result), "rehearsal_complete", notes, evidence);
      },
    },

    {
      id: "05-not-found",
      category: "Business outcome",
      title: "No such member",
      input: "member 99999",
      expected: "business_outcome:MEMBER_NOT_FOUND",
      why: "A legitimate answer the caller needs, not a crash (the brief's own example).",
      run: async () => {
        const { result, evidence } = await replayCase("05-not-found", lookup, { memberId: "99999" });
        return expectEq(summarize(result), "business_outcome:MEMBER_NOT_FOUND", [], evidence);
      },
    },
    {
      id: "06-permission-denied",
      category: "Business outcome",
      title: "Teller not authorized for this member",
      input: "member 40000 (restricted)",
      expected: "business_outcome:PERMISSION_DENIED",
      why: "Permission denials are a normal state of a bank system and an answer the agent must relay.",
      run: async () => {
        const { result, evidence } = await replayCase("06-permission-denied", lookup, { memberId: "40000" });
        return expectEq(summarize(result), "business_outcome:PERMISSION_DENIED", [], evidence);
      },
    },
    {
      id: "07-validation-error",
      category: "Business outcome",
      title: "The bank app rejects the input",
      input: "open_member_subaccount, $5.00 deposit (minimum $25)",
      expected: "business_outcome:VALIDATION_ERROR",
      why: "A validation error from the app is reported as what it is, before anything irreversible is reached.",
      run: async () => {
        const { result, evidence } = await replayCase("07-validation-error", sub, { memberId: "23456", initialDeposit: "5.00" });
        return expectEq(summarize(result), "business_outcome:VALIDATION_ERROR", [], evidence);
      },
    },
    {
      id: "08-declined",
      category: "Human handoff",
      title: "Irreversible step: the human declines",
      input: "open_member_subaccount, operator clicks Decline",
      expected: "business_outcome:DECLINED_BY_OPERATOR",
      why: "A person saying no is an answer, and nothing irreversible happens.",
      run: async () => {
        const { result, evidence } = await replayCase("08-declined", sub, { memberId: "12345", initialDeposit: "40.00" }, {
          operator: async (r) => {
            await waitForHuman(r);
            r.sessionManager.resume("decline");
          },
        });
        return expectEq(summarize(result), "business_outcome:DECLINED_BY_OPERATOR", [], evidence);
      },
    },
    {
      id: "26-supervisor-override",
      category: "Human handoff",
      title: "A step only a person may do: supervisor override PIN",
      input: "open_member_subaccount, $15,000.00 deposit (≥ $10,000 needs a supervisor)",
      expected: "success",
      why: "Automation isn't allowed to hold or type a supervisor's PIN, so it doesn't try: it pauses immediately with an instruction. A supervisor enters the PIN on the same live page, and the flow continues to the irreversible step, which still needs its own confirmation. The PIN is never recorded.",
      run: async () => {
        const PIN = "2468"; // the demo supervisor's; known to "the supervisor", not to the artifact
        const { run, result, evidence } = await replayCase("26-supervisor-override", sub, { memberId: "23456", initialDeposit: "15000.00" }, {
          operator: async (r) => {
            await waitForHuman(r, "task");
            await humanFills(r, "Supervisor PIN", PIN);
            await humanClicks(r, "Approve Override");
            r.sessionManager.resume("continue");
            await waitForHuman(r, "policy");
            await humanClicks(r, "Confirm and Open Account");
            r.sessionManager.resume("continue");
          },
        });
        const kinds = run.tracker.record.interventions.map((i) => i.kind);
        const log = readFileSync(path.join(run.tracker.record.evidenceDir, "log.jsonl"), "utf-8");
        const pinLeaked = log.includes(PIN);
        return expectEq(summarize(result), "success", [
          `handoffs, in order: ${kinds.join(" → ")} (supervisor task, then irreversible confirmation)`,
          `transitions: ${run.tracker.record.transitions.map((t) => t.to).join(" → ")}`,
          `PIN in evidence: ${pinLeaked ? "YES (leak)" : "no; the fill is recorded as [REDACTED]"}`,
        ], evidence, kinds.join(",") === "task,policy" && !pinLeaked);
      },
    },
    {
      id: "27-override-declined",
      category: "Human handoff",
      title: "The supervisor refuses the override",
      input: "$15,000.00 deposit; supervisor clicks Decline",
      expected: "business_outcome:DECLINED_BY_OPERATOR",
      why: "A supervisor saying no is an answer the calling agent needs, and nothing is opened.",
      run: async () => {
        const { result, evidence } = await replayCase("27-override-declined", sub, { memberId: "23456", initialDeposit: "15000.00" }, {
          operator: async (r) => {
            await waitForHuman(r, "task");
            r.sessionManager.resume("decline");
          },
        });
        return expectEq(summarize(result), "business_outcome:DECLINED_BY_OPERATOR", [], evidence);
      },
    },
    {
      id: "28-override-not-done",
      category: "Hard failure",
      title: "Control handed back but the required step wasn't done",
      input: "$15,000.00 deposit; operator resumes without entering a PIN",
      expected: "failure:HUMAN_TASK_INCOMPLETE",
      why: "The engine checks the page instead of trusting \"done\": the override screen is still there, so it stops rather than carrying on.",
      run: async () => {
        const { result, evidence } = await replayCase("28-override-not-done", sub, { memberId: "23456", initialDeposit: "15000.00" }, {
          operator: async (r) => {
            await waitForHuman(r, "task");
            r.sessionManager.resume("continue");
          },
        });
        return expectEq(summarize(result), "failure:HUMAN_TASK_INCOMPLETE", failureNotes(result), evidence);
      },
    },
    {
      id: "29-no-operator-response",
      category: "Hard failure",
      title: "Nobody answers a pause",
      input: "open_member_subaccount; no operator responds before the timeout (2s here, 15 min by default)",
      expected: "failure:OPERATOR_TIMEOUT",
      why: "A paused run can't hold a browser session and the app's login forever. It times out, nothing irreversible happens, and the session is released.",
      run: async () => {
        const { run, result, evidence } = await replayCase("29-no-operator-response", sub, { memberId: "12345", initialDeposit: "40.00" }, { timeoutMs: 2000 });
        const decision = run.tracker.record.interventions[0]?.decision;
        return expectEq(summarize(result), "failure:OPERATOR_TIMEOUT", [`hand-back recorded as: ${decision}`], evidence, decision === "timeout");
      },
    },
    {
      id: "09-resumed-unconfirmed",
      category: "Human handoff",
      title: "Control handed back without confirming",
      input: "operator presses Resume but never clicks Confirm",
      expected: "business_outcome:DECLINED_BY_OPERATOR",
      why: "From a real session: the engine checks whether the action happened instead of assuming it did.",
      run: async () => {
        const { result, evidence } = await replayCase("09-resumed-unconfirmed", sub, { memberId: "12345", initialDeposit: "40.00" }, {
          operator: async (r) => {
            await waitForHuman(r);
            r.sessionManager.resume("continue");
          },
        });
        return expectEq(summarize(result), "business_outcome:DECLINED_BY_OPERATOR", [], evidence);
      },
    },

    {
      id: "10-transient-retried",
      category: "Recoverable",
      title: "Core system times out once; retried automatically",
      input: "member 50000 (first load per session returns 504)",
      expected: "success",
      why: "Transient slowness is handled by the artifact's own retry policy, without bothering a person.",
      run: async () => {
        const { run, result, evidence } = await replayCase("10-transient-retried", lookup, { memberId: "50000" });
        const recovered = events(run).filter((e) => e.event === "replay.recovered");
        return expectEq(summarize(result), "success", recovered.map((e) => `recovered from ${e.code} after ${e.attempt} automatic attempt(s)`), evidence, recovered.length > 0);
      },
    },
    {
      id: "11-interstitial-dismissed",
      category: "Recoverable",
      title: "A known interstitial is dismissed",
      input: "member 80000 (compliance notice must be acknowledged first)",
      expected: hasInterstitialCheck ? "success" : "failure:LOCATOR_NOT_FOUND",
      why: hasInterstitialCheck
        ? "The brief's \"dismiss a known interstitial\": the artifact names the screen and the control that clears it, so replay clicks through it."
        : "This artifact version predates the interstitial check, so it fails cleanly instead of guessing (run `npm run revise` to add it).",
      run: async () => {
        const { run, result, evidence } = await replayCase("11-interstitial-dismissed", lookup, { memberId: "80000" });
        const recovered = events(run).filter((e) => e.event === "replay.recovered");
        const notes = [...recovered.map((e) => `dismissed ${e.code}`), ...failureNotes(result)];
        if (result?.status === "success") notes.push(`outputs: ${JSON.stringify(result.outputs)}`);
        return expectEq(summarize(result), hasInterstitialCheck ? "success" : "failure:LOCATOR_NOT_FOUND", notes, evidence);
      },
    },
    {
      id: "12-exhausted-human-fixes",
      category: "Recoverable",
      title: "Retries run out; a person fixes it on the live page",
      input: "member 50002 (fails 3 times per session, retry budget is 2)",
      expected: "success",
      why: "Retry, then alert: automation doesn't give up silently, and only a condition that outlives its retries reaches a person, who acts on the same session.",
      run: async () => {
        const { run, result, evidence } = await replayCase("12-exhausted-human-fixes", lookup, { memberId: "50002" }, {
          operator: async (r) => {
            await waitForHuman(r);
            await humanClicks(r, "Retry"); // the error page's own retry link
            r.sessionManager.resume("continue");
          },
        });
        const i = run.tracker.record.interventions[0];
        return expectEq(summarize(result), "success", [
          `intervention kind: ${i?.kind}, human actions: ${i?.humanActions}`,
          `transitions: ${run.tracker.record.transitions.map((t) => t.to).join(" → ")}`,
        ], evidence, i?.kind === "fault");
      },
    },

    {
      id: "13-exhausted-given-up",
      category: "Hard failure",
      title: "Retries run out and the person gives up",
      input: "member 50002, operator clicks Give up",
      expected: "failure:RECOVERY_EXHAUSTED",
      why: "When neither automation nor a person can clear it, the run stops with a clear, debuggable failure.",
      run: async () => {
        const { result, evidence } = await replayCase("13-exhausted-given-up", lookup, { memberId: "50002" }, {
          operator: async (r) => {
            await waitForHuman(r);
            r.sessionManager.resume("decline");
          },
        });
        return expectEq(summarize(result), "failure:RECOVERY_EXHAUSTED", failureNotes(result), evidence);
      },
    },
    {
      id: "14-session-expired",
      category: "Hard failure",
      title: "Session expires mid-flow",
      input: "member 60000 (loading the record ends the session)",
      expected: "failure:SESSION_EXPIRED",
      why: "Re-authentication belongs to the connection layer, not to a recorded flow, so the capability stops and says so.",
      run: async () => {
        const { result, evidence } = await replayCase("14-session-expired", lookup, { memberId: "60000" });
        return expectEq(summarize(result), "failure:SESSION_EXPIRED", failureNotes(result), evidence);
      },
    },
    {
      id: "15-drift-beyond-fallbacks",
      category: "Hard failure",
      title: "A tenant changed a label no fallback covers",
      input: 'member 12345 on tenant C ("Savings Balance" row relabelled "Share Savings")',
      expected: "failure:LOCATOR_NOT_FOUND",
      why: "Replay never guesses which value is the balance. It stops and reports what it looked for and what it found: exactly the signal for a per-tenant override.",
      run: async () => {
        await setSkin("tenant-c");
        try {
          const { result, evidence } = await replayCase("15-drift-beyond-fallbacks", lookup, { memberId: "12345" });
          return expectEq(summarize(result), "failure:LOCATOR_NOT_FOUND", failureNotes(result), evidence);
        } finally {
          await setSkin("standard");
        }
      },
    },
    {
      id: "16-invalid-input",
      category: "Hard failure",
      title: "Malformed input",
      input: 'memberId "abc"',
      expected: "failure:INVALID_PARAMS",
      why: "Bad input is rejected by the artifact's contract before anything is clicked.",
      run: async () => {
        const { result, evidence } = await replayCase("16-invalid-input", lookup, { memberId: "abc" });
        return expectEq(summarize(result), "failure:INVALID_PARAMS", failureNotes(result), evidence);
      },
    },

    {
      id: "17-off-allowlist",
      category: "Guardrail",
      title: "A tampered artifact tries to leave the allowed app",
      input: "lookup_member_balance with a step navigating to https://example.com/",
      expected: "failure:ORIGIN_NOT_ALLOWED",
      why: "The allowlist is enforced on every navigation, whatever the artifact says.",
      run: async () => {
        const tampered: Artifact = {
          ...lookup,
          steps: [{ type: "navigate", urlTemplate: "https://example.com/", description: "tampered step" }, ...lookup.steps],
        };
        const { result, evidence } = await replayCase("17-off-allowlist", tampered, { memberId: "12345" });
        return expectEq(summarize(result), "failure:ORIGIN_NOT_ALLOWED", failureNotes(result), evidence);
      },
    },
    {
      id: "18-hardcoded-input",
      category: "Guardrail",
      title: "A recording that ignores a caller's input is refused",
      input: "open_member_subaccount whose deposit step types a fixed 60",
      expected: "rejected",
      why: "The real bug this guards against: the model typed 60 for a seed of 60.00, which would have deposited $60 on every replay.",
      run: async () => {
        const broken: Artifact = JSON.parse(JSON.stringify(sub));
        for (const s of broken.steps) if (s.type === "fill" && s.valueTemplate === "{{initialDeposit}}") s.valueTemplate = "60";
        try {
          assertContract(broken);
          return { actual: "saved", ok: false, notes: ["contract check did not object"] };
        } catch (e) {
          const rejected = e instanceof ArtifactContractError;
          return { actual: rejected ? "rejected" : "error", ok: rejected, notes: [e instanceof Error ? e.message : String(e)] };
        }
      },
    },

    {
      id: "19-approval-refused",
      category: "Lifecycle",
      title: "Approval is refused without evidence",
      input: "approve a version with fewer than 8 counted runs",
      expected: "refused",
      why: "A reviewer's name isn't enough; approval needs replay evidence.",
      run: async () => {
        // A copy with no runs, in a scratch folder, so the real artifacts are never touched.
        const scratch = mkdtempSync(path.join(tmpdir(), "approval-check-"));
        const fresh: Artifact = { ...lookup, version: 9000, provenance: { ...lookup.provenance, reviewedBy: null, approval: null } };
        writeFileSync(path.join(scratch, `${fresh.name}.v${fresh.version}.json`), JSON.stringify(fresh));
        const realDir = process.env.ARTIFACTS_DIR;
        process.env.ARTIFACTS_DIR = scratch;
        try {
          approveArtifact(fresh.name, "scenario-check", { version: fresh.version });
          return { actual: "approved", ok: false, notes: ["a version with no evidence was approved"] };
        } catch (e) {
          return { actual: e instanceof ApprovalRefused ? "refused" : "error", ok: e instanceof ApprovalRefused, notes: [(e as Error).message] };
        } finally {
          if (realDir === undefined) delete process.env.ARTIFACTS_DIR;
          else process.env.ARTIFACTS_DIR = realDir;
        }
      },
    },
  ];
}


async function apiScenarios(): Promise<{ meta: Omit<Scenario, "run">; outcome: Outcome }[]> {
  const keys = { agent: `agt_${randomBytes(12).toString("hex")}`, operator: `op_${randomBytes(12).toString("hex")}` };
  const { app } = createCapabilityApp(async () => browser, keys);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const api = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const call = async (method: string, p: string, body?: unknown, who: "agent" | "operator" | null = "agent") => {
    const res = await fetch(api + p, {
      method,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(who ? { Authorization: `Bearer ${keys[who]}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };

  const out: { meta: Omit<Scenario, "run">; outcome: Outcome }[] = [];
  const add = (meta: Omit<Scenario, "run">, outcome: Outcome) => out.push({ meta, outcome });

  try {
    const tools = await call("GET", "/api/capabilities?format=openai");
    const names = (tools.body as unknown as any[]).map((t) => t.function.name);
    add(
      { id: "20-catalog", category: "Agent API", title: "An agent discovers what it can call", input: "GET /api/capabilities?format=openai (agent key)", expected: "approved tools only", why: "Tool definitions are generated from the approved artifacts, so they can't drift from what replays." },
      { actual: names.length ? "approved tools only" : "no tools", ok: names.length > 0, notes: [`tools offered: ${names.join(", ")}`] }
    );

    const inv = await call("POST", "/api/capabilities/lookup_member_balance/invoke", { params: { memberId: "12345" }, idempotencyKey: `scn-${STAMP}` });
    add(
      { id: "21-invoke", category: "Agent API", title: "Invoke a capability by name with typed args", input: "POST /api/capabilities/lookup_member_balance/invoke", expected: "200 COMPLETED", why: "How an agent uses a recorded capability in production." },
      { actual: `${inv.status} ${inv.body.state}`, ok: inv.status === 200 && inv.body.state === "COMPLETED", notes: [`served version v${inv.body.version}`, `outputs: ${JSON.stringify(inv.body.result?.outputs)}`] }
    );

    const retry = await call("POST", "/api/capabilities/lookup_member_balance/invoke", { params: { memberId: "12345" }, idempotencyKey: `scn-${STAMP}` });
    const reuse = await call("POST", "/api/capabilities/lookup_member_balance/invoke", { params: { memberId: "23456" }, idempotencyKey: `scn-${STAMP}` });
    add(
      { id: "22-idempotency", category: "Agent API", title: "A retried request doesn't run twice", input: "same idempotency key twice, then with different input", expected: "same run, then 409", why: "An agent retrying a timed-out \"open account\" must get the original run back, not a second account." },
      {
        actual: `${retry.body.runId === inv.body.runId ? "same run" : "new run"}, then ${reuse.status}`,
        ok: retry.body.runId === inv.body.runId && reuse.status === 409,
        notes: [`retry idempotent=${retry.body.idempotent}`, `reuse with different input: ${reuse.body.error}`],
      }
    );

    const bad = await call("POST", "/api/capabilities/lookup_member_balance/invoke", { params: { memberId: "12345", ssn: "123-45-6789" } });
    add(
      { id: "23-unknown-input", category: "Agent API", title: "An undeclared field is rejected", input: "invoke with an extra `ssn` field", expected: "400 UNKNOWN_PARAMS", why: "Sending data a capability doesn't declare is a contract violation, and PII shouldn't be accepted just because it was sent." },
      { actual: `${bad.status} ${bad.body.error}`, ok: bad.status === 400 && bad.body.error === "UNKNOWN_PARAMS", notes: [] }
    );

    const paused = await call("POST", "/api/capabilities/open_member_subaccount/invoke", { params: { memberId: "23456", initialDeposit: "30.00" } });
    const op = paused.body.intervention?.operatorUrl as string | undefined;
    const selfApprove = op ? await call("POST", `${op}api/resume`, { decision: "continue" }, "agent") : { status: 0, body: {} };
    const supervised = await call("POST", "/api/capabilities/open_member_subaccount/invoke", { params: { memberId: "23456", initialDeposit: "30.00" }, supervised: true }, "agent");
    const anon = await call("GET", "/api/capabilities", undefined, null);
    add(
      { id: "24-separation-of-duties", category: "Agent API", title: "An agent can't approve its own irreversible action", input: "agent key: resume its own paused run; start a supervised run; no key at all", expected: "403, 403, 401", why: "The approval gate means nothing if the caller can confirm for itself." },
      {
        actual: `${selfApprove.status}, ${supervised.status}, ${anon.status}`,
        ok: paused.status === 202 && selfApprove.status === 403 && supervised.status === 403 && anon.status === 401,
        notes: [`irreversible call returned ${paused.status} ${paused.body.state}`, `self-approval: ${selfApprove.body.error}`, `supervised by agent: ${supervised.body.error}`],
      }
    );
    if (op) {
      await call("POST", `${op}api/resume`, { decision: "decline" }, "operator");
      const done = await call("GET", `/api/runs/${paused.body.runId}?wait=terminal`);
      add(
        { id: "25-agent-waits-out-human", category: "Agent API", title: "The agent learns the human's decision", input: "agent long-polls the paused run; operator declines", expected: "BUSINESS_OUTCOME DECLINED_BY_OPERATOR", why: "Paused is a state, not an error: the agent polls until a person decides." },
        { actual: `${done.body.state} ${done.body.result?.code}`, ok: done.body.state === "BUSINESS_OUTCOME" && done.body.result?.code === "DECLINED_BY_OPERATOR", notes: [] }
      );
    }
  } finally {
    server.close();
  }
  return out;
}


async function main() {
  const health = await fetch(`${BASE_URL}/login`).then((r) => r.ok).catch(() => false);
  if (!health) {
    console.error(`Target app isn't reachable at ${BASE_URL}. Start it with \`npm run target-app\`.`);
    process.exit(2);
  }
  browser = await chromium.launch();
  const results: { meta: Omit<Scenario, "run">; outcome: Outcome }[] = [];
  try {
    for (const s of scenarios()) {
      const { run, ...meta } = s;
      let outcome: Outcome;
      try {
        outcome = await run();
      } catch (e) {
        outcome = { actual: "error", ok: false, notes: [e instanceof Error ? e.message : String(e)] };
      }
      results.push({ meta, outcome });
      console.log(`${outcome.ok ? "PASS" : "FAIL"}  ${meta.id.padEnd(26)} expected ${meta.expected.padEnd(40)} got ${outcome.actual}`);
    }
    for (const r of await apiScenarios()) {
      results.push(r);
      console.log(`${r.outcome.ok ? "PASS" : "FAIL"}  ${r.meta.id.padEnd(26)} expected ${r.meta.expected.padEnd(40)} got ${r.outcome.actual}`);
    }
  } finally {
    await setSkin("standard").catch(() => undefined);
    await browser.close();
  }

  const passed = results.filter((r) => r.outcome.ok).length;
  let row = 0;
  const order: Category[] = ["Success", "Business outcome", "Recoverable", "Human handoff", "Hard failure", "Guardrail", "Lifecycle", "Agent API"];
  const md: string[] = [
    "# Scenario catalog",
    "",
    `${passed}/${results.length} cases produced exactly the expected result. Run on ${new Date().toISOString()} against \`${BASE_URL}\` with \`npm run scenarios\`.`,
    "",
    `Artifacts under test: ${["lookup_member_balance", "open_member_subaccount"].map((n) => `${n} v${latest(n).version}`).join(", ")}. Member IDs are masked. Scenario runs are tagged \`scenario\` in the ledger and never count toward reliability scores, because their failures are injected on purpose.`,
    "",
    "| # | Case | Input | Expected | Actual | |",
    "|---|---|---|---|---|---|",
    ...order.flatMap((cat) =>
      results
        .filter((r) => r.meta.category === cat)
        .map((r) => `| ${++row} | **${cat}**: ${r.meta.title} | ${mask(r.meta.input)} | \`${r.meta.expected}\` | \`${r.outcome.actual}\` | ${r.outcome.ok ? "pass" : "FAIL"} |`)
    ),
    "",
    "## Details",
    ...order.flatMap((cat) =>
      results
        .filter((r) => r.meta.category === cat)
        .flatMap((r) => [
          "",
          `### ${r.meta.id}: ${r.meta.title}`,
          "",
          r.meta.why,
          "",
          ...r.outcome.notes.map((n) => `- ${mask(n)}`),
          ...(r.outcome.evidence ? [`- evidence: [\`${r.outcome.evidence.split("/").pop()}/\`](./${r.outcome.evidence.split("/").pop()}/)`] : []),
        ])
    ),
  ];
  writeFileSync(path.join(OUT, "README.md"), md.join("\n") + "\n");
  console.log(`\n${passed}/${results.length} passed. Report: ${path.relative(process.cwd(), OUT)}/README.md`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
