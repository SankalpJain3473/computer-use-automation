import type { Page, Response } from "playwright";
import type { Artifact, OutcomeDefinition, Step } from "../artifact/schema.js";
import { resolveLocator, LocatorResolutionError } from "./resolver.js";
import { evaluateCondition } from "./conditions.js";
import {
  assertOriginAllowed,
  assertActionTypeAllowed,
  mayAutoConfirmIrreversible,
  GuardrailViolation,
} from "../guardrails/policy.js";
import type { ReplayResult } from "./results.js";
import type { RunLogger } from "../logging/logger.js";
import type { SessionManager } from "../escalation/session-manager.js";

export interface ReplayDeps {
  page: Page;
  logger: RunLogger;
  sessionManager?: SessionManager;
  // rehearsal: stop before the first irreversible step, after checking its control resolves.
  mode?: "live" | "rehearsal";
  // Supervised runs confirm irreversible steps by hand even when unattended execution is approved.
  forceHumanConfirm?: boolean;
  // Which tenant's instance to run against; defaults to where the artifact was recorded. Still allowlisted.
  origin?: string;
}

interface Ctx {
  artifact: Artifact;
  params: Record<string, string | number>;
  deps: ReplayDeps;
  lastStatus?: number;
  outputs: Record<string, string | number>;
}

function renderTemplate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(params[name] ?? ""));
}

function applyTransform(raw: string, transform: "none" | "trim" | "currencyToCents"): string | number {
  if (transform === "trim") return raw.trim();
  if (transform === "currencyToCents") return Math.round(Number(raw.replace(/[^0-9.-]/g, "")) * 100);
  return raw;
}

function failure(i: number, step: string, expected: string, observed: string, errorCode: string, message = observed): ReplayResult {
  return { status: "failure", stepIndex: i, stepDescription: step, expected, observed, errorCode, message };
}

export async function validateParams(
  artifact: Artifact,
  params: Record<string, string | number>
): Promise<{ ok: true } | { ok: false; message: string }> {
  for (const p of artifact.inputParams) {
    if (p.required && (params[p.name] === undefined || params[p.name] === "")) {
      return { ok: false, message: `Missing required input parameter "${p.name}"` };
    }
    if (p.pattern && params[p.name] !== undefined && !new RegExp(p.pattern).test(String(params[p.name]))) {
      return { ok: false, message: `Input parameter "${p.name}" does not match required pattern ${p.pattern}` };
    }
  }
  return { ok: true };
}

export async function replay(
  artifact: Artifact,
  params: Record<string, string | number>,
  deps: ReplayDeps
): Promise<ReplayResult> {
  const ctx: Ctx = { artifact, params, deps, outputs: {} };
  const onResponse = (resp: Response) => {
    if (resp.request().resourceType() === "document" && resp.frame() === deps.page.mainFrame()) ctx.lastStatus = resp.status();
  };
  deps.page.on("response", onResponse);
  try {
    return await run(ctx);
  } finally {
    deps.page.off("response", onResponse);
  }
}

async function run(ctx: Ctx): Promise<ReplayResult> {
  const { artifact, params, deps } = ctx;
  const { page, logger } = deps;
  logger.log("replay.phase", { phase: "pre", mode: deps.mode ?? "live" });

  const check = await validateParams(artifact, params);
  if (!check.ok) {
    return failure(-1, "input validation", "all required parameters present and well-formed", check.message, "INVALID_PARAMS");
  }

  if (artifact.steps[0]?.type !== "navigate") {
    const entry = new URL(renderTemplate(artifact.target.entryPathTemplate, params), deps.origin ?? artifact.target.allowedOrigin).toString();
    try {
      assertOriginAllowed(entry);
      const resp = await page.goto(entry);
      ctx.lastStatus = resp?.status() ?? ctx.lastStatus;
      logger.log("replay.entry", { url: entry, status: ctx.lastStatus });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failure(-1, "navigate to the capability's entry point", `entry point ${entry} to load`, message, "ENTRY_UNREACHABLE");
    }
  }

  logger.log("replay.phase", { phase: "core" });
  for (let i = 0; i < artifact.steps.length; i++) {
    const step = artifact.steps[i]!;
    logger.log("replay.step.start", { stepIndex: i, type: step.type, description: step.description });
    try {
      assertActionTypeAllowed(step.type);
      const early = await runStep(ctx, step, i);
      if (early) return early;
    } catch (err) {
      if (err instanceof LocatorResolutionError) {
        return failure(i, step.description, "exactly one match for the recorded locator strategies", JSON.stringify(err.attempts), "LOCATOR_NOT_FOUND", err.message);
      }
      if (err instanceof GuardrailViolation) {
        logger.log("replay.guardrail_blocked", { stepIndex: i, code: err.code, message: err.message });
        return failure(i, step.description, "an action inside the allowlist", err.message, err.code, `Blocked by guardrail: ${err.message}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      return failure(i, step.description, "step to execute without throwing", message, "UNEXPECTED_ERROR");
    }
    logger.log("replay.step.ok", { stepIndex: i });
  }

  logger.log("replay.phase", { phase: "post" });
  if (!(await evaluateCondition(page, artifact.successCheckpoint, { lastStatus: ctx.lastStatus }))) {
    return failure(
      artifact.steps.length,
      "final success checkpoint",
      JSON.stringify(artifact.successCheckpoint),
      `url=${page.url()}`,
      "SUCCESS_CHECKPOINT_NOT_MET",
      "All steps ran but the success condition was not met"
    );
  }

  const outputs: Record<string, string | number> = {};
  for (const o of artifact.outputs) if (o.name in ctx.outputs) outputs[o.name] = ctx.outputs[o.name]!;
  return { status: "success", outputs, stepsExecuted: artifact.steps.length };
}

async function runStep(ctx: Ctx, step: Step, i: number): Promise<ReplayResult | undefined> {
  const { artifact, params, deps } = ctx;
  const { page, logger } = deps;

  switch (step.type) {
    case "navigate": {
      const url = new URL(renderTemplate(step.urlTemplate, params), deps.origin ?? artifact.target.allowedOrigin).toString();
      assertOriginAllowed(url);
      const resp = await page.goto(url);
      ctx.lastStatus = resp?.status() ?? ctx.lastStatus;
      return;
    }
    case "click": {
      const resolved = await resolveLocator(page, step.target);
      if (resolved.driftDetected) logger.log("replay.locator_drift", { stepIndex: i, strategyIndex: resolved.strategyIndex });
      await resolved.locator.click();
      await page.waitForLoadState("networkidle").catch(() => undefined);
      assertOriginAllowed(page.url());
      return;
    }
    case "fill": {
      const resolved = await resolveLocator(page, step.target);
      await resolved.locator.fill(renderTemplate(step.valueTemplate, params));
      return;
    }
    case "selectOption": {
      const resolved = await resolveLocator(page, step.target);
      await resolved.locator.selectOption(renderTemplate(step.valueTemplate, params));
      return;
    }
    case "extract": {
      const resolved = await resolveLocator(page, step.target);
      ctx.outputs[step.outputName] = applyTransform((await resolved.locator.textContent()) ?? "", step.transform);
      return;
    }
    case "assertCheckpoint": {
      if (await evaluateCondition(page, step.condition, { lastStatus: ctx.lastStatus })) return;
      return failure(i, step.description, JSON.stringify(step.condition), `url=${page.url()}`, "CHECKPOINT_FAILED", "Checkpoint condition was not satisfied");
    }
    case "checkOutcomes": {
      const matched = await matchOutcome(ctx, step.outcomes, i);
      if (!matched) return;
      if (matched.category === "business_outcome") {
        logger.log("replay.business_outcome", { stepIndex: i, code: matched.code });
        return { status: "business_outcome", code: matched.code, description: matched.description, stepsExecuted: i + 1 };
      }
      if (matched.category === "failure") return failure(i, step.description, "happy path continuation", matched.description, matched.code);
      return failure(
        i,
        step.description,
        "transient condition to clear after retry",
        matched.description,
        "RECOVERY_EXHAUSTED",
        `Recoverable condition "${matched.code}" did not clear`
      );
    }
    case "confirmIrreversible":
      return confirmIrreversible(ctx, step, i);
  }
}

async function confirmIrreversible(ctx: Ctx, step: Extract<Step, { type: "confirmIrreversible" }>, i: number): Promise<ReplayResult | undefined> {
  const { artifact, deps } = ctx;
  const { page, logger, sessionManager } = deps;

  if (deps.mode === "rehearsal") {
    const resolved = await resolveLocator(page, step.target);
    logger.log("replay.rehearsal_stop", { stepIndex: i, strategyIndex: resolved.strategyIndex });
    return { status: "rehearsal_complete", stoppedBeforeStep: i, stepsExecuted: i, confirmTargetStrategy: resolved.strategyIndex };
  }

  if (!deps.forceHumanConfirm && mayAutoConfirmIrreversible(artifact)) {
    const resolved = await resolveLocator(page, step.target);
    logger.log("replay.auto_confirm_irreversible", { stepIndex: i, description: step.description });
    await resolved.locator.click();
    await page.waitForLoadState("networkidle").catch(() => undefined);
    return;
  }

  if (!sessionManager) {
    return failure(i, step.description, "an operator to confirm an irreversible action", "no operator channel for this run", "ESCALATION_UNAVAILABLE");
  }
  // Never ask a person to confirm a control that isn't on screen.
  await resolveLocator(page, step.target);
  logger.log("replay.escalate_confirm", { stepIndex: i, description: step.description });
  const decision = await sessionManager.requestIntervention({
    kind: "policy",
    capabilityName: artifact.name,
    goal: `Replay of ${artifact.name}`,
    stepIndex: i,
    reason: `Irreversible step requires human confirmation: ${step.description}`,
  });

  // The page decides whether the action happened, not the hand-back button.
  const stillUnconfirmed = await resolveLocator(page, step.target).then(
    () => true,
    () => false
  );
  if (!stillUnconfirmed) return;
  logger.log("replay.not_confirmed", { stepIndex: i, decision });
  if (decision === "timeout") {
    return failure(i, step.description, "an operator to confirm or decline", "no operator responded in time; nothing was confirmed", "OPERATOR_TIMEOUT");
  }
  return {
    status: "business_outcome",
    code: "DECLINED_BY_OPERATOR",
    description:
      decision === "decline"
        ? "An operator reviewed the irreversible step and declined it"
        : "Control was handed back without the irreversible step being confirmed",
    stepsExecuted: i + 1,
  };
}

function synthetic(outcome: OutcomeDefinition, code: string, category: OutcomeDefinition["category"], description: string): OutcomeDefinition {
  return { ...outcome, code, category, description };
}

async function matchOutcome(ctx: Ctx, outcomes: OutcomeDefinition[], stepIndex: number): Promise<OutcomeDefinition | undefined> {
  const { page, logger } = ctx.deps;
  const matches = (o: OutcomeDefinition) => evaluateCondition(page, o.detect, { lastStatus: ctx.lastStatus });

  for (const outcome of outcomes) {
    if (!(await matches(outcome))) continue;
    if (outcome.category !== "recoverable") return outcome;
    if (outcome.recovery?.action === "human") return humanTask(ctx, outcome, stepIndex);

    const recovery = outcome.recovery;
    const maxAttempts = recovery?.maxAttempts ?? 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.log("replay.recovery_attempt", { stepIndex, code: outcome.code, attempt, action: recovery?.action ?? "wait" });
      await page.waitForTimeout(recovery?.waitMs ?? 1500);
      if (recovery?.action === "reload") {
        await page.reload().catch(() => undefined);
      } else if (recovery?.action === "dismiss" && recovery.target) {
        const control = await resolveLocator(page, recovery.target).catch(() => undefined);
        if (control) {
          await control.locator.click();
          await page.waitForLoadState("networkidle").catch(() => undefined);
        }
      }
      if (!(await matches(outcome))) {
        logger.log("replay.recovered", { stepIndex, code: outcome.code, attempt });
        return undefined;
      }
    }

    if (!ctx.deps.sessionManager) return outcome;
    logger.log("replay.recovery_exhausted_escalate", { stepIndex, code: outcome.code });
    const decision = await ctx.deps.sessionManager.requestIntervention({
      kind: "fault",
      capabilityName: ctx.artifact.name,
      goal: `Replay of ${ctx.artifact.name}`,
      stepIndex,
      reason: `"${outcome.code}" (${outcome.description}) did not clear after ${maxAttempts} automatic retries. Fix it on the page, then resume.`,
    });
    if (decision === "decline") return outcome;
    if (!(await matches(outcome))) {
      logger.log("replay.recovery_resolved_by_human", { stepIndex, code: outcome.code });
      return undefined;
    }
    if (decision === "timeout") return synthetic(outcome, "OPERATOR_TIMEOUT", "failure", "No operator responded in time");
    return outcome;
  }
  return undefined;
}

async function humanTask(ctx: Ctx, outcome: OutcomeDefinition, stepIndex: number): Promise<OutcomeDefinition | undefined> {
  const { page, logger, sessionManager } = ctx.deps;
  if (!sessionManager) {
    return synthetic(outcome, "ESCALATION_UNAVAILABLE", "failure", `"${outcome.code}" needs a person, but this run has no operator channel`);
  }
  logger.log("replay.human_task", { stepIndex, code: outcome.code });
  const decision = await sessionManager.requestIntervention({
    kind: "task",
    capabilityName: ctx.artifact.name,
    goal: `Replay of ${ctx.artifact.name}`,
    stepIndex,
    reason: `${outcome.description}. ${outcome.recovery?.instruction ?? ""}`.trim(),
  });

  const stillNeeded = await evaluateCondition(page, outcome.detect, { lastStatus: ctx.lastStatus });
  if (!stillNeeded) {
    logger.log("replay.human_task_done", { stepIndex, code: outcome.code });
    return undefined;
  }
  logger.log("replay.human_task_not_done", { stepIndex, code: outcome.code, decision });
  if (decision === "decline") {
    return synthetic(outcome, "DECLINED_BY_OPERATOR", "business_outcome", `A person declined a required step (${outcome.code})`);
  }
  if (decision === "timeout") return synthetic(outcome, "OPERATOR_TIMEOUT", "failure", `No one completed "${outcome.code}" in time`);
  return synthetic(outcome, "HUMAN_TASK_INCOMPLETE", "failure", `Control came back but "${outcome.code}" still needs doing`);
}
