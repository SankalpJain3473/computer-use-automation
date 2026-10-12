import path from "node:path";
import type { Browser } from "playwright";
import type { Artifact } from "../artifact/schema.js";
import { isApproved } from "../guardrails/policy.js";
import { redactDeep } from "../guardrails/redact.js";
import { evidenceRoot } from "../logging/logger.js";
import { validateParams } from "../replay/engine.js";
import { startReplayRun, type StartedRun } from "../runs/executor.js";
import { readLedger } from "../runs/stats.js";
import { TERMINAL_STATES, type LedgerEntry, type RunRecord } from "../runs/tracker.js";
import type { InterventionRequest } from "../escalation/types.js";

const MAX_ACTIVE_RUNS = Number(process.env.MAX_ACTIVE_RUNS ?? 4);
const MAX_RETAINED_RUNS = 500;

export class InvokeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "InvokeError";
  }
}

export interface LiveRun extends StartedRun {
  artifact: Artifact;
  paramsKey: string;
}

export interface InvokeRequest {
  params: unknown;
  idempotencyKey?: string;
  supervised?: boolean;
  mode?: "live" | "rehearsal";
}

export class RunRegistry {
  private readonly runs = new Map<string, LiveRun>();
  // In memory only: keys don't survive a restart.
  private readonly byKey = new Map<string, string>();

  constructor(private readonly getBrowser: () => Promise<Browser>) {}

  private isActive(run: LiveRun): boolean {
    return !TERMINAL_STATES.includes(run.tracker.record.state);
  }

  async invoke(artifact: Artifact, req: InvokeRequest): Promise<{ run: LiveRun; idempotent: boolean }> {
    const params = coerceParams(artifact, req.params);
    const paramsKey = JSON.stringify(Object.entries(params).sort());
    const key = req.idempotencyKey ? `${artifact.name}:${req.idempotencyKey}` : undefined;

    if (key) {
      const existing = this.runs.get(this.byKey.get(key) ?? "");
      if (existing) {
        if (existing.paramsKey !== paramsKey) {
          throw new InvokeError(409, "IDEMPOTENCY_KEY_REUSED", `Idempotency key "${req.idempotencyKey}" was already used with different parameters.`);
        }
        return { run: existing, idempotent: true };
      }
    }

    const check = await validateParams(artifact, params);
    if (!check.ok) throw new InvokeError(400, "INVALID_PARAMS", check.message);

    const supervised = req.supervised === true;
    if (!supervised && !isApproved(artifact)) {
      throw new InvokeError(403, "CAPABILITY_NOT_APPROVED", `${artifact.name} v${artifact.version} is not approved.`);
    }

    const active = [...this.runs.values()].filter((r) => this.isActive(r)).length;
    if (active >= MAX_ACTIVE_RUNS) {
      throw new InvokeError(429, "AT_CAPACITY", `${active} runs are already in progress. Retry shortly.`, { retryAfterSeconds: 5 });
    }

    const started = await startReplayRun({
      browser: await this.getBrowser(),
      artifact,
      params,
      mode: req.mode ?? "live",
      invokedBy: supervised ? "operator" : "agent",
      idempotencyKey: req.idempotencyKey,
      forceHumanConfirm: supervised,
      logDir: path.join(evidenceRoot(), "server-runs", `replay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
      quiet: true,
    });
    const run: LiveRun = { ...started, artifact, paramsKey };
    this.runs.set(run.runId, run);
    if (key) this.byKey.set(key, run.runId);
    this.prune();
    return { run, idempotent: false };
  }

  private prune(): void {
    if (this.runs.size <= MAX_RETAINED_RUNS) return;
    for (const [id, run] of this.runs) {
      if (this.runs.size <= MAX_RETAINED_RUNS) break;
      if (this.isActive(run)) continue;
      this.runs.delete(id);
      if (run.tracker.record.idempotencyKey) this.byKey.delete(`${run.artifact.name}:${run.tracker.record.idempotencyKey}`);
    }
  }

  get(runId: string): LiveRun | undefined {
    return this.runs.get(runId);
  }

  /** "settled": finished or paused for a person. "terminal": finished. Gives up after timeoutMs. */
  waitFor(run: LiveRun, until: "settled" | "terminal", timeoutMs: number): Promise<void> {
    const terminal = () => TERMINAL_STATES.includes(run.tracker.record.state);
    const settled = () => terminal() || (until === "settled" && run.tracker.record.state === "AWAITING_HUMAN");
    // When finished, also wait for the result to be written.
    const finish = (resolve: () => void) => (terminal() ? void run.done.finally(resolve) : resolve());
    if (settled()) return new Promise(finish);
    return new Promise((resolve) => {
      const unsubscribe = run.tracker.subscribe(() => {
        if (!settled()) return;
        clearTimeout(timer);
        unsubscribe();
        finish(resolve);
      });
      const timer = setTimeout(() => {
        unsubscribe();
        resolve();
      }, timeoutMs);
    });
  }

  openInterventions(): InterventionRequest[] {
    return [...this.runs.values()].map((r) => r.sessionManager.getOpenRequest()).filter((x): x is InterventionRequest => !!x);
  }

  list(limit = 50): { live: RunRecord[]; history: LedgerEntry[] } {
    const live = [...this.runs.values()].map((r) => redactDeep(r.tracker.record)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const liveIds = new Set(live.map((r) => r.runId));
    const history = readLedger()
      .filter((e) => !liveIds.has(e.runId))
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
      .slice(0, limit);
    return { live: live.slice(0, limit), history };
  }
}

// Undeclared fields are rejected rather than dropped: they're a contract violation, and often PII.
function coerceParams(artifact: Artifact, raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvokeError(400, "INVALID_PARAMS", "params must be an object");
  }
  const input = raw as Record<string, unknown>;
  const declared = new Set(artifact.inputParams.map((p) => p.name));
  const unknown = Object.keys(input).filter((k) => !declared.has(k));
  if (unknown.length) {
    throw new InvokeError(400, "UNKNOWN_PARAMS", `Unknown parameter(s): ${unknown.join(", ")}`, { expected: [...declared] });
  }
  const params: Record<string, string> = {};
  for (const p of artifact.inputParams) {
    const v = input[p.name];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" && typeof v !== "number") throw new InvokeError(400, "INVALID_PARAMS", `"${p.name}" must be a ${p.type}`);
    params[p.name] = String(v);
  }
  return params;
}
