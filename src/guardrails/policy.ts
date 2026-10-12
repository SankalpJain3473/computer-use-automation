import { loadAllowlist } from "./allowlist.js";
import type { Artifact, Step } from "../artifact/schema.js";

export class GuardrailViolation extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "GuardrailViolation";
  }
}

// Also checked after every click, so a redirect can't take a run off the allowlist.
export function assertOriginAllowed(url: string): void {
  const { allowedOrigins } = loadAllowlist();
  const origin = new URL(url).origin;
  if (!allowedOrigins.includes(origin)) {
    throw new GuardrailViolation(`Origin ${origin} is not in the allowlist (${allowedOrigins.join(", ")})`, "ORIGIN_NOT_ALLOWED");
  }
}

export function assertActionTypeAllowed(stepType: string): void {
  const { allowedActionTypes } = loadAllowlist();
  if (!allowedActionTypes.includes(stepType)) {
    throw new GuardrailViolation(`Action type "${stepType}" is not in the allowlist`, "ACTION_TYPE_NOT_ALLOWED");
  }
}

export function artifactContainsIrreversibleStep(steps: Step[]): boolean {
  return steps.some((s) => s.type === "confirmIrreversible");
}

// Approval lets agents call a version; running its irreversible step unattended is a separate grant.
export function isApproved(artifact: Artifact): boolean {
  return artifact.provenance.reviewedBy !== null && artifact.provenance.approval !== null;
}

export function mayAutoConfirmIrreversible(artifact: Artifact): boolean {
  return isApproved(artifact) && artifact.provenance.approval?.unattendedIrreversible === true;
}
