import type { Browser } from "playwright";
import { nanoid } from "nanoid";
import type { Artifact } from "../artifact/schema.js";
import { RunLogger } from "../logging/logger.js";
import { sensitiveValues } from "../guardrails/redact.js";
import { SessionManager } from "../escalation/session-manager.js";
import { replay } from "../replay/engine.js";
import type { ReplayResult } from "../replay/results.js";
import { BASE_URL, bootstrapSession } from "../target-app-client.js";
import { RunTracker, type InvokedBy } from "./tracker.js";

export interface StartReplayOptions {
  browser: Browser;
  artifact: Artifact;
  params: Record<string, string>;
  mode?: "live" | "rehearsal";
  invokedBy: InvokedBy;
  idempotencyKey?: string;
  forceHumanConfirm?: boolean;
  logDir?: string;
  quiet?: boolean;
  interventionTimeoutMs?: number;
}

export interface StartedRun {
  runId: string;
  tracker: RunTracker;
  sessionManager: SessionManager;
  done: Promise<ReplayResult | undefined>;
}

// Returns once the session exists, so the caller can wire up the operator console before any pause.
export async function startReplayRun(opts: StartReplayOptions): Promise<StartedRun> {
  const runId = nanoid(8);
  const logger = new RunLogger(runId, "replay", { dir: opts.logDir, quiet: opts.quiet });
  logger.maskValues(sensitiveValues(opts.artifact.inputParams, opts.params));
  const tracker = new RunTracker(
    {
      runId,
      kind: "replay",
      capability: opts.artifact.name,
      version: opts.artifact.version,
      mode: opts.mode ?? "live",
      invokedBy: opts.invokedBy,
      idempotencyKey: opts.idempotencyKey,
      params: opts.params,
    },
    logger
  );
  logger.log("replay.start", { capability: opts.artifact.name, version: opts.artifact.version, params: opts.params });

  const context = await opts.browser.newContext();
  const page = await context.newPage();
  const sessionManager = new SessionManager(page, logger, { timeoutMs: opts.interventionTimeoutMs });

  const done = (async () => {
    try {
      await bootstrapSession(page);
      const result = await replay(opts.artifact, opts.params, {
        page,
        logger,
        sessionManager,
        mode: opts.mode,
        forceHumanConfirm: opts.forceHumanConfirm,
        origin: new URL(BASE_URL).origin,
      });
      await logger.screenshot(page, "final");
      logger.writeJson("replay-result", result);
      tracker.finishReplay(result);
      return result;
    } catch (err) {
      await logger.screenshot(page, "crash");
      logger.log("replay.harness_error", { error: err instanceof Error ? err.message : String(err) });
      tracker.crash(err);
      return undefined;
    } finally {
      await context.close().catch(() => undefined);
    }
  })();

  return { runId, tracker, sessionManager, done };
}
