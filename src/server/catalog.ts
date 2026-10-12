import type { Artifact, OutcomeDefinition } from "../artifact/schema.js";
import { artifactContainsIrreversibleStep, isApproved } from "../guardrails/policy.js";
import type { VersionStats } from "../runs/stats.js";

export interface JsonSchema {
  type: "object";
  properties: Record<string, { type: string; description: string; pattern?: string }>;
  required: string[];
  additionalProperties: false;
}

export interface CatalogEntry {
  name: string;
  version: number;
  description: string;
  riskLevel: "safe" | "risky";
  approval: {
    state: "approved" | "draft";
    reviewedBy: string | null;
    approvedAt: string | null;
    unattendedIrreversible: boolean;
    evidence: { runs: number; confidence: number; mode: string } | null;
  };
  pausesForHuman: boolean;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  outcomes: { code: string; category: OutcomeDefinition["category"]; description: string; needsPerson?: boolean }[];
  reliability: Pick<VersionStats, "runs" | "confidence" | "band" | "successRate" | "p50Ms" | "driftRuns"> | null;
  stepCount: number;
  invoke: { method: "POST"; path: string };
}

export function inputSchema(artifact: Artifact): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(
      artifact.inputParams.map((p) => [
        p.name,
        { type: p.type, description: p.description, ...(p.pattern ? { pattern: p.pattern } : {}) },
      ])
    ),
    required: artifact.inputParams.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}

export function outputSchema(artifact: Artifact): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(artifact.outputs.map((o) => [o.name, { type: o.type, description: o.description }])),
    required: artifact.outputs.map((o) => o.name),
    additionalProperties: false,
  };
}

export function declaredOutcomes(artifact: Artifact): CatalogEntry["outcomes"] {
  const seen = new Map<string, CatalogEntry["outcomes"][number]>();
  for (const step of artifact.steps) {
    if (step.type !== "checkOutcomes") continue;
    for (const o of step.outcomes) {
      seen.set(o.code, {
        code: o.code,
        category: o.category,
        description: o.description,
        ...(o.recovery?.action === "human" ? { needsPerson: true } : {}),
      });
    }
  }
  if (artifactContainsIrreversibleStep(artifact.steps)) {
    seen.set("DECLINED_BY_OPERATOR", {
      code: "DECLINED_BY_OPERATOR",
      category: "business_outcome",
      description: "a human operator declined the irreversible action; nothing was changed",
    });
  }
  return [...seen.values()];
}

export function catalogEntry(artifact: Artifact, stats: VersionStats | undefined): CatalogEntry {
  const approval = artifact.provenance.approval;
  const irreversible = artifactContainsIrreversibleStep(artifact.steps);
  return {
    name: artifact.name,
    version: artifact.version,
    description: artifact.description,
    riskLevel: artifact.riskLevel,
    approval: {
      state: isApproved(artifact) ? "approved" : "draft",
      reviewedBy: artifact.provenance.reviewedBy,
      approvedAt: approval?.approvedAt ?? null,
      unattendedIrreversible: approval?.unattendedIrreversible ?? false,
      evidence: approval?.evidence ?? null,
    },
    pausesForHuman: irreversible && !(approval?.unattendedIrreversible ?? false),
    inputSchema: inputSchema(artifact),
    outputSchema: outputSchema(artifact),
    outcomes: declaredOutcomes(artifact),
    reliability: stats
      ? {
          runs: stats.runs,
          confidence: Number(stats.confidence.toFixed(3)),
          band: stats.band,
          successRate: Number(stats.successRate.toFixed(3)),
          p50Ms: stats.p50Ms,
          driftRuns: stats.driftRuns,
        }
      : null,
    stepCount: artifact.steps.length,
    invoke: { method: "POST", path: `/api/capabilities/${artifact.name}/invoke` },
  };
}

export function agentDescription(entry: CatalogEntry): string {
  const parts = [entry.description];
  const outs = Object.keys(entry.outputSchema.properties);
  if (outs.length) parts.push(`On success returns: ${outs.join(", ")}.`);
  const business = entry.outcomes.filter((o) => o.category === "business_outcome");
  if (business.length) {
    parts.push(
      `May instead return a business outcome (a valid answer, not an error): ${business
        .map((o) => `${o.code} (${o.description})`)
        .join("; ")}.`
    );
  }
  const tasks = entry.outcomes.filter((o) => o.needsPerson);
  if (tasks.length) {
    parts.push(
      `Some calls need a person to act before they can continue (${tasks.map((o) => `${o.code}: ${o.description}`).join("; ")}); those return AWAITING_HUMAN until someone does, or DECLINED_BY_OPERATOR if they refuse.`
    );
  }
  if (entry.pausesForHuman) {
    parts.push(
      "Performs an irreversible action: every call pauses for a human operator to confirm, so the response may be AWAITING_HUMAN; poll the run until it finishes."
    );
  }
  return parts.join(" ");
}

export function toolDefinitions(entries: CatalogEntry[], format: "openai" | "anthropic") {
  return entries.map((e) =>
    format === "anthropic"
      ? { name: e.name, description: agentDescription(e), input_schema: e.inputSchema }
      : { type: "function" as const, function: { name: e.name, description: agentDescription(e), parameters: e.inputSchema } }
  );
}
