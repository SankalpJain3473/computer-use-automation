import { describe, it, expect } from "vitest";
import { computeStats, wilsonLowerBound } from "./stats.js";
import type { LedgerEntry } from "./tracker.js";

function entry(over: Partial<LedgerEntry>): LedgerEntry {
  return {
    runId: Math.random().toString(36).slice(2),
    capability: "cap",
    version: 1,
    mode: "live",
    invokedBy: "stability",
    state: "COMPLETED",
    resultStatus: "success",
    interventionKinds: [],
    driftSteps: 0,
    durationMs: 1000,
    endedAt: new Date().toISOString(),
    ...over,
  };
}

describe("wilsonLowerBound", () => {
  it("does not treat a handful of perfect runs as proof", () => {
    expect(wilsonLowerBound(3, 3)).toBeLessThan(0.5);
    expect(wilsonLowerBound(10, 10)).toBeGreaterThan(0.7);
    expect(wilsonLowerBound(20, 20)).toBeGreaterThan(wilsonLowerBound(10, 10));
  });

  it("ranks 97/100 above 3/3, unlike a raw success rate", () => {
    expect(wilsonLowerBound(97, 100)).toBeGreaterThan(wilsonLowerBound(3, 3));
  });

  it("is 0 with no evidence", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe("computeStats", () => {
  it("counts business outcomes as correct and caller errors as not the artifact's fault", () => {
    const [s] = computeStats([
      ...Array.from({ length: 8 }, () => entry({})),
      entry({ state: "BUSINESS_OUTCOME", resultStatus: "business_outcome", code: "MEMBER_NOT_FOUND" }),
      entry({ state: "FAILED", resultStatus: "failure", code: "INVALID_PARAMS" }),
    ]);
    expect(s!.runs).toBe(9);
    expect(s!.callerErrors).toBe(1);
    expect(s!.successRate).toBe(1);
  });

  it("does not penalise a by-design policy pause, but does penalise a rescue", () => {
    const [s] = computeStats([
      entry({ interventionKinds: ["policy"] }),
      entry({ interventionKinds: ["fault"] }),
      entry({ state: "FAILED", resultStatus: "failure", code: "LOCATOR_NOT_FOUND" }),
    ]);
    expect(s!.clean).toBe(1);
    expect(s!.assisted).toBe(1);
    expect(s!.failures).toBe(1);
  });

  it("reports insufficient evidence below the minimum run count instead of a confident band", () => {
    const [s] = computeStats([entry({}), entry({}), entry({})]);
    expect(s!.successRate).toBe(1);
    expect(s!.band).toBe("insufficient");
  });

  it("goes green once there are enough clean runs, and tracks drift separately", () => {
    const [s] = computeStats([...Array.from({ length: 11 }, () => entry({})), entry({ driftSteps: 1 })]);
    expect(s!.band).toBe("green");
    expect(s!.driftRuns).toBe(1);
  });

  it("ignores scenario runs, whose failures are injected on purpose", () => {
    const [s] = computeStats([...Array.from({ length: 10 }, () => entry({})), entry({ invokedBy: "scenario", state: "FAILED", resultStatus: "failure", code: "SESSION_EXPIRED" })]);
    expect(s!.failures).toBe(0);
    expect(s!.runs).toBe(10);
  });

  it("keeps versions apart, so a new version starts from zero evidence", () => {
    const rows = computeStats([...Array.from({ length: 10 }, () => entry({ version: 1 })), entry({ version: 2 })]);
    expect(rows.find((r) => r.version === 2)!.band).toBe("insufficient");
  });
});
