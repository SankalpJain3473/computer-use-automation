import { existsSync, readFileSync } from "node:fs";
import { ledgerPath, type LedgerEntry } from "./tracker.js";
import { loadAllowlist } from "../guardrails/allowlist.js";

// Scored by the Wilson 95% lower bound, so 3/3 doesn't outrank 97/100.

export type Band = "green" | "amber" | "red" | "insufficient";

export interface VersionStats {
  capability: string;
  version: number;
  runs: number; // runs that count toward reliability (excludes caller errors)
  clean: number; // completed with no fault/agent intervention (policy pauses are by design)
  businessOutcomes: number;
  assisted: number; // needed a human because automation got stuck
  failures: number;
  callerErrors: number; // INVALID_PARAMS - the caller's fault, not the artifact's
  rehearsals: number;
  driftRuns: number;
  successRate: number;
  confidence: number; // Wilson 95% lower bound of (clean + businessOutcomes) / runs
  band: Band;
  p50Ms: number | null;
  p95Ms: number | null;
  lastRunAt: string | null;
}

const CALLER_ERROR_CODES = new Set(["INVALID_PARAMS"]);

export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

export function bandFor(confidence: number, runs: number): Band {
  const { minRuns, minConfidence } = loadAllowlist().approvalPolicy;
  if (runs < minRuns) return "insufficient";
  if (confidence >= minConfidence) return "green";
  if (confidence >= minConfidence / 2) return "amber";
  return "red";
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function readLedger(): LedgerEntry[] {
  const file = ledgerPath();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LedgerEntry);
}

export function computeStats(entries: LedgerEntry[]): VersionStats[] {
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    if (e.mode === "discovery" || e.version === undefined) continue;
    if (e.invokedBy === "scenario") continue; // injected faults are not evidence about the artifact
    const key = `${e.capability}@${e.version}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }

  const out: VersionStats[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    let clean = 0;
    let businessOutcomes = 0;
    let assisted = 0;
    let failures = 0;
    let callerErrors = 0;
    let rehearsals = 0;
    let driftRuns = 0;
    const durations: number[] = [];

    for (const e of group) {
      if (e.code && CALLER_ERROR_CODES.has(e.code)) {
        callerErrors++;
        continue;
      }
      durations.push(e.durationMs);
      if (e.driftSteps > 0) driftRuns++;
      if (e.resultStatus === "rehearsal_complete") rehearsals++;
      const neededRescue = e.interventionKinds.some((k) => k === "fault" || k === "agent");
      if (e.state === "FAILED") failures++;
      else if (e.state === "BUSINESS_OUTCOME") businessOutcomes++;
      else if (neededRescue) assisted++;
      else clean++;
    }

    const runs = clean + businessOutcomes + assisted + failures;
    const correct = clean + businessOutcomes;
    const confidence = wilsonLowerBound(correct, runs);
    durations.sort((a, b) => a - b);
    out.push({
      capability: first.capability,
      version: first.version!,
      runs,
      clean,
      businessOutcomes,
      assisted,
      failures,
      callerErrors,
      rehearsals,
      driftRuns,
      successRate: runs ? correct / runs : 0,
      confidence,
      band: bandFor(confidence, runs),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      lastRunAt: group.map((e) => e.endedAt).sort().at(-1) ?? null,
    });
  }
  return out.sort((a, b) => a.capability.localeCompare(b.capability) || b.version - a.version);
}

export function statsFor(capability: string, version: number): VersionStats | undefined {
  return computeStats(readLedger()).find((s) => s.capability === capability && s.version === version);
}
