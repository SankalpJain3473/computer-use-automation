import { describe, it, expect } from "vitest";
import { assertContract, unboundParams, ArtifactContractError } from "./validate.js";
import type { Artifact } from "./schema.js";

function artifact(depositTemplate: string): Artifact {
  return {
    schemaVersion: 1,
    id: "x",
    name: "open_member_subaccount",
    version: 2,
    description: "",
    riskLevel: "risky",
    target: { appName: "", allowedOrigin: "http://localhost:4173", entryPathTemplate: "/members/search" },
    inputParams: [
      { name: "memberId", type: "string", description: "", required: true },
      { name: "initialDeposit", type: "string", description: "", required: true },
    ],
    outputs: [],
    successCheckpoint: { kind: "textVisible", text: "x" },
    steps: [
      { type: "fill", target: { strategies: [{ kind: "formField", name: "memberId" }] }, valueTemplate: "{{memberId}}", description: "" },
      { type: "fill", target: { strategies: [{ kind: "formField", name: "initialDeposit" }] }, valueTemplate: depositTemplate, description: "" },
    ],
    provenance: { recordedAt: "", discoveryRunId: "", model: "", reviewedBy: null, approval: null },
  };
}

describe("artifact contract", () => {
  it("rejects a recording that hard-coded the discovery run's amount", () => {
    // The real failure this guards against: the model typed 60 for a seed of
    // "60.00", so the deposit wasn't recognised as the parameter.
    const a = artifact("60");
    expect(unboundParams(a)).toEqual(["initialDeposit"]);
    expect(() => assertContract(a)).toThrow(ArtifactContractError);
  });

  it("accepts an artifact where every input drives a step", () => {
    expect(() => assertContract(artifact("{{initialDeposit}}"))).not.toThrow();
  });

  it("rejects placeholders for inputs that were never declared", () => {
    const a = artifact("{{initialDeposit}}");
    a.steps.push({ type: "navigate", urlTemplate: "/members/{{branchId}}", description: "" });
    expect(() => assertContract(a)).toThrow(/undeclared/);
  });
});
