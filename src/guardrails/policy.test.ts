import { describe, it, expect } from "vitest";
import { isApproved, mayAutoConfirmIrreversible, assertOriginAllowed, GuardrailViolation } from "./policy.js";
import type { Artifact } from "../artifact/schema.js";

function artifact(reviewedBy: string | null, unattendedIrreversible?: boolean): Artifact {
  return {
    schemaVersion: 1,
    id: "x",
    name: "x",
    version: 1,
    description: "",
    riskLevel: "risky",
    target: { appName: "", allowedOrigin: "http://localhost:4173", entryPathTemplate: "/" },
    inputParams: [],
    outputs: [],
    successCheckpoint: { kind: "textVisible", text: "x" },
    steps: [],
    provenance: {
      recordedAt: "",
      discoveryRunId: "",
      model: "",
      reviewedBy,
      approval:
        unattendedIrreversible === undefined
          ? null
          : { approvedAt: "", unattendedIrreversible, evidence: { runs: 10, confidence: 0.75, mode: "live" } },
    },
  };
}

describe("approval policy", () => {
  it("treats a name without evidence as a draft", () => {
    expect(isApproved(artifact("someone"))).toBe(false);
  });

  it("approval alone does not unlock unattended irreversible actions", () => {
    const a = artifact("reviewer", false);
    expect(isApproved(a)).toBe(true);
    expect(mayAutoConfirmIrreversible(a)).toBe(false);
  });

  it("unattended irreversible needs both approval and the explicit opt-in", () => {
    expect(mayAutoConfirmIrreversible(artifact("reviewer", true))).toBe(true);
    expect(mayAutoConfirmIrreversible(artifact(null, true))).toBe(false);
  });
});

describe("origin allowlist", () => {
  it("rejects anything off the allowlist", () => {
    expect(() => assertOriginAllowed("https://evil.example/members")).toThrow(GuardrailViolation);
    expect(() => assertOriginAllowed("http://localhost:4173/members/1")).not.toThrow();
  });
});
