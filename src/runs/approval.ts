import { loadArtifact, saveArtifact } from "../artifact/store.js";
import type { Artifact } from "../artifact/schema.js";
import { loadAllowlist } from "../guardrails/allowlist.js";
import { statsFor } from "./stats.js";

export class ApprovalRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRefused";
  }
}

// Unattended irreversible execution needs live evidence: rehearsals never run past the irreversible step.
export function approveArtifact(
  name: string,
  reviewer: string,
  opts: { version?: number; unattendedIrreversible?: boolean } = {}
): Artifact {
  const artifact = loadArtifact(name, opts.version);
  const { minRuns, minConfidence } = loadAllowlist().approvalPolicy;
  const stats = statsFor(name, artifact.version);

  if (!stats || stats.band !== "green") {
    const have = stats
      ? `${stats.runs} counted run(s), confidence ${stats.confidence.toFixed(2)} (${stats.band})`
      : "no recorded replays";
    throw new ApprovalRefused(
      `${name} v${artifact.version} needs at least ${minRuns} runs with confidence >= ${minConfidence} to be approved; it has ${have}. Run \`npm run stability -- --capability=${name} ...\` first.`
    );
  }

  const unattendedIrreversible = artifact.riskLevel === "risky" && opts.unattendedIrreversible === true;
  const liveRuns = stats.runs - stats.rehearsals;
  if (unattendedIrreversible && liveRuns < minRuns) {
    throw new ApprovalRefused(
      `Unattended irreversible execution needs ${minRuns} live runs (each human-confirmed); ${name} v${artifact.version} has ${liveRuns}. Rehearsals don't count here: they never exercise the steps after the irreversible one.`
    );
  }

  artifact.provenance.reviewedBy = reviewer;
  artifact.provenance.approval = {
    approvedAt: new Date().toISOString(),
    unattendedIrreversible,
    evidence: {
      runs: stats.runs,
      confidence: Number(stats.confidence.toFixed(3)),
      mode: stats.rehearsals > 0 ? "rehearsal" : "live",
    },
  };
  saveArtifact(artifact);
  return artifact;
}

export function revokeApproval(name: string, version?: number): Artifact {
  const artifact = loadArtifact(name, version);
  artifact.provenance.reviewedBy = null;
  artifact.provenance.approval = null;
  saveArtifact(artifact);
  return artifact;
}
