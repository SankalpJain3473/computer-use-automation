import { writeFileSync } from "node:fs";
import path from "node:path";
import { appendJsonLine, evidenceRoot, type RunLogger } from "../logging/logger.js";
import type { ReplayResult } from "../replay/results.js";
import type { HandbackDecision, InterventionKind } from "../escalation/types.js";

export type RunState = "INITIALIZED" | "RUNNING" | "AWAITING_HUMAN" | "COMPLETED" | "BUSINESS_OUTCOME" | "FAILED";
export const TERMINAL_STATES: readonly RunState[] = ["COMPLETED", "BUSINESS_OUTCOME", "FAILED"];

const ALLOWED: Record<RunState, readonly RunState[]> = {
  INITIALIZED: ["RUNNING", "FAILED"],
  RUNNING: ["AWAITING_HUMAN", "COMPLETED", "BUSINESS_OUTCOME", "FAILED"],
  AWAITING_HUMAN: ["RUNNING", "FAILED"],
  COMPLETED: [],
  BUSINESS_OUTCOME: [],
  FAILED: [],
};

export class IllegalTransitionError extends Error {
  constructor(from: RunState, to: RunState) {
    super(`Illegal run state transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export type RunMode = "live" | "rehearsal" | "discovery";
// Scenario runs inject faults on purpose; they're kept in the ledger but excluded from reliability.
export type InvokedBy = "cli" | "agent" | "operator" | "stability" | "scenario";

export interface StepTiming {
  index: number;
  type: string;
  startedAt: string;
  durationMs?: number;
  driftStrategyIndex?: number;
}

export interface InterventionSummary {
  id: string;
  kind: InterventionKind;
  stepIndex: number;
  reason: string;
  openedAt: string;
  resolvedAt?: string;
  decision?: HandbackDecision;
  humanActions: number;
}

export interface RunRecord {
  runId: string;
  kind: "replay" | "discovery";
  capability: string;
  version?: number;
  mode: RunMode;
  invokedBy: InvokedBy;
  idempotencyKey?: string;
  params: Record<string, unknown>;
  state: RunState;
  controller: "automation" | "human";
  phase?: "pre" | "core" | "post";
  transitions: { from: RunState | null; to: RunState; at: string; reason?: string }[];
  steps: StepTiming[];
  interventions: InterventionSummary[];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  result?: ReplayResult | { status: "discovery_finished"; success: boolean; summary: string };
  evidenceDir: string;
}

export interface LedgerEntry {
  runId: string;
  capability: string;
  version?: number;
  mode: RunMode;
  invokedBy: InvokedBy;
  idempotencyKey?: string;
  state: RunState;
  resultStatus?: string;
  code?: string;
  interventionKinds: InterventionKind[];
  driftSteps: number;
  durationMs: number;
  endedAt: string;
}

export function ledgerPath(): string {
  return path.join(evidenceRoot(), "ledger.jsonl");
}

export class RunTracker {
  readonly record: RunRecord;
  private readonly listeners: ((r: RunRecord) => void)[] = [];
  private readonly startedMs = Date.now();

  constructor(
    init: {
      runId: string;
      kind: "replay" | "discovery";
      capability: string;
      version?: number;
      mode: RunMode;
      invokedBy: InvokedBy;
      idempotencyKey?: string;
      params: Record<string, unknown>;
    },
    private readonly logger: RunLogger
  ) {
    const now = new Date().toISOString();
    this.record = {
      ...init,
      state: "INITIALIZED",
      controller: "automation",
      transitions: [{ from: null, to: "INITIALIZED", at: now }],
      steps: [],
      interventions: [],
      startedAt: now,
      evidenceDir: logger.runDir,
    };
    logger.on((event, data) => this.onEvent(event, data));
    this.persist();
  }

  subscribe(fn: (r: RunRecord) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.includes(this.record.state);
  }

  transition(to: RunState, reason?: string): void {
    const from = this.record.state;
    if (!ALLOWED[from].includes(to)) throw new IllegalTransitionError(from, to);
    this.record.state = to;
    this.record.transitions.push({ from, to, at: new Date().toISOString(), reason });
    this.changed();
  }

  finishReplay(result: ReplayResult): void {
    const to: RunState =
      result.status === "business_outcome" ? "BUSINESS_OUTCOME" : result.status === "failure" ? "FAILED" : "COMPLETED";
    const code =
      result.status === "business_outcome" ? result.code : result.status === "failure" ? result.errorCode : undefined;
    this.end(to, result, code);
  }

  finishDiscovery(success: boolean, summary: string): void {
    this.end(success ? "COMPLETED" : "FAILED", { status: "discovery_finished", success, summary });
  }

  /** For crashes outside the engine's own error handling (browser died, etc.). */
  crash(err: unknown): void {
    if (this.isTerminal) return;
    const message = err instanceof Error ? err.message : String(err);
    this.end(
      "FAILED",
      {
        status: "failure",
        stepIndex: -1,
        stepDescription: "run harness",
        expected: "run to complete",
        observed: message,
        errorCode: "HARNESS_ERROR",
        message,
      },
      "HARNESS_ERROR"
    );
  }

  private end(to: RunState, result: NonNullable<RunRecord["result"]>, code?: string): void {
    this.record.result = result;
    this.record.endedAt = new Date().toISOString();
    this.record.durationMs = Date.now() - this.startedMs;
    this.transition(to, code);
    const entry: LedgerEntry = {
      runId: this.record.runId,
      capability: this.record.capability,
      version: this.record.version,
      mode: this.record.mode,
      invokedBy: this.record.invokedBy,
      idempotencyKey: this.record.idempotencyKey,
      state: to,
      resultStatus: result.status,
      code,
      interventionKinds: this.record.interventions.map((i) => i.kind),
      driftSteps: this.record.steps.filter((s) => s.driftStrategyIndex !== undefined).length,
      durationMs: this.record.durationMs,
      endedAt: this.record.endedAt,
    };
    appendJsonLine(ledgerPath(), entry);
  }

  private onEvent(event: string, data: Record<string, unknown>): void {
    const r = this.record;
    switch (event) {
      case "replay.phase":
        r.phase = data.phase as RunRecord["phase"];
        if (r.state === "INITIALIZED") this.transition("RUNNING");
        break;
      case "agent.observe":
        if (r.state === "INITIALIZED") this.transition("RUNNING");
        break;
      case "replay.step.start":
        r.steps.push({ index: Number(data.stepIndex), type: String(data.type), startedAt: new Date().toISOString() });
        break;
      case "agent.decide":
        r.steps.push({ index: Number(data.turn), type: String(data.tool), startedAt: new Date().toISOString() });
        break;
      case "replay.step.ok": {
        const step = this.lastStep(Number(data.stepIndex));
        if (step) step.durationMs = Date.now() - Date.parse(step.startedAt);
        break;
      }
      case "replay.locator_drift": {
        const step = this.lastStep(Number(data.stepIndex));
        if (step) step.driftStrategyIndex = Number(data.strategyIndex);
        break;
      }
      case "intervention.requested":
        r.interventions.push({
          id: String(data.id),
          kind: data.kind as InterventionKind,
          stepIndex: Number(data.stepIndex),
          reason: String(data.reason),
          openedAt: String(data.createdAt),
          humanActions: 0,
        });
        r.controller = "human";
        this.transition("AWAITING_HUMAN", String(data.reason));
        return;
      case "intervention.human_action": {
        const open = r.interventions.find((i) => !i.resolvedAt);
        if (open) open.humanActions += 1;
        break;
      }
      case "intervention.resumed": {
        const open = r.interventions.find((i) => i.id === data.id);
        if (open) {
          open.resolvedAt = new Date().toISOString();
          open.decision = (data.decision as HandbackDecision) ?? "continue";
        }
        r.controller = "automation";
        this.transition(
          "RUNNING",
          data.decision === "decline" ? "operator declined" : data.decision === "timeout" ? "no operator response" : "handed back to automation"
        );
        return;
      }
      default:
        return;
    }
    this.changed();
  }

  private lastStep(index: number): StepTiming | undefined {
    for (let i = this.record.steps.length - 1; i >= 0; i--) {
      if (this.record.steps[i]!.index === index) return this.record.steps[i];
    }
    return undefined;
  }

  private changed(): void {
    this.persist();
    for (const l of this.listeners) l(this.record);
  }

  private persist(): void {
    writeFileSync(path.join(this.logger.runDir, "run.json"), JSON.stringify(this.logger.scrub(this.record), null, 2), "utf-8");
  }
}
