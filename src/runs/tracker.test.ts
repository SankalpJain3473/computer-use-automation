import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RunLogger } from "../logging/logger.js";
import { RunTracker, IllegalTransitionError } from "./tracker.js";

function newTracker(id: string) {
  const logger = new RunLogger(id, "replay", { quiet: true });
  const tracker = new RunTracker(
    { runId: id, kind: "replay", capability: "cap", version: 1, mode: "live", invokedBy: "cli", params: { memberId: "1234567" } },
    logger
  );
  return { logger, tracker };
}

describe("RunTracker", () => {
  it("follows engine and handoff events through the state machine", () => {
    const { logger, tracker } = newTracker(`tsm-${Date.now()}`);
    logger.log("replay.phase", { phase: "pre" });
    logger.log("replay.step.start", { stepIndex: 0, type: "click" });
    logger.log("replay.locator_drift", { stepIndex: 0, strategyIndex: 2 });
    logger.log("replay.step.ok", { stepIndex: 0 });
    logger.log("intervention.requested", { id: "i1", kind: "policy", stepIndex: 1, reason: "confirm", createdAt: new Date().toISOString() });
    expect(tracker.record.state).toBe("AWAITING_HUMAN");
    expect(tracker.record.controller).toBe("human");
    logger.log("intervention.human_action", { type: "click" });
    logger.log("intervention.resumed", { id: "i1" });
    tracker.finishReplay({ status: "success", outputs: {}, stepsExecuted: 2 });

    const r = tracker.record;
    expect(r.transitions.map((t) => t.to)).toEqual(["INITIALIZED", "RUNNING", "AWAITING_HUMAN", "RUNNING", "COMPLETED"]);
    expect(r.controller).toBe("automation");
    expect(r.steps[0]!.driftStrategyIndex).toBe(2);
    expect(r.interventions[0]!.humanActions).toBe(1);
  });

  it("refuses illegal transitions instead of silently recording them", () => {
    const { tracker } = newTracker(`tsm-illegal-${Date.now()}`);
    expect(() => tracker.transition("COMPLETED")).toThrow(IllegalTransitionError);
    tracker.transition("RUNNING");
    tracker.finishReplay({ status: "business_outcome", code: "MEMBER_NOT_FOUND", description: "x", stepsExecuted: 3 });
    expect(tracker.record.state).toBe("BUSINESS_OUTCOME");
    expect(() => tracker.transition("RUNNING")).toThrow(IllegalTransitionError);
  });

  it("writes a redacted audit record to disk", () => {
    const { logger, tracker } = newTracker(`tsm-disk-${Date.now()}`);
    tracker.transition("RUNNING");
    const onDisk = JSON.parse(readFileSync(path.join(logger.runDir, "run.json"), "utf-8"));
    expect(onDisk.state).toBe("RUNNING");
    expect(onDisk.params.memberId).toBe("***4567");
    expect(tracker.record.params.memberId).toBe("1234567");
  });
});
