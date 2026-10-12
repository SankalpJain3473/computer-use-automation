import { describe, it, expect } from "vitest";
import { CAPABILITIES, stripReviewLayer } from "./definitions.js";
import type { Step } from "../artifact/schema.js";

const plan = (name: string) => ({ strategies: [{ kind: "role" as const, role: "button", name, exact: true }] });

// Shaped like a real discovery trace for opening a sub-account.
const recorded: Step[] = [
  { type: "fill", target: { strategies: [{ kind: "formField", name: "memberId" }] }, valueTemplate: "{{memberId}}", description: "member id" },
  { type: "click", target: plan("Look Up Member"), description: "search" },
  { type: "click", target: plan("Open New Sub-Account"), description: "open form" },
  { type: "fill", target: { strategies: [{ kind: "formField", name: "initialDeposit" }] }, valueTemplate: "{{initialDeposit}}", description: "deposit" },
  { type: "click", target: plan("Continue"), description: "continue" },
  { type: "click", target: plan("Confirm and Open Account"), description: "confirm" },
];

describe("review layer", () => {
  const augmented = CAPABILITIES.open_member_subaccount!.augment(recorded);

  it("adds the outcome checks, the irreversible marker, the human task, and the output extraction", () => {
    const types = augmented.map((s) => s.type);
    expect(types).toContain("confirmIrreversible");
    expect(types.filter((t) => t === "checkOutcomes")).toHaveLength(2);
    const codes = augmented.flatMap((s) => (s.type === "checkOutcomes" ? s.outcomes.map((o) => o.code) : []));
    expect(codes).toEqual(expect.arrayContaining(["MEMBER_NOT_FOUND", "VALIDATION_ERROR", "SUPERVISOR_OVERRIDE", "COMPLIANCE_NOTICE"]));
    expect(augmented.some((s) => s.type === "extract" && s.outputName === "new_account_number")).toBe(true);
  });

  it("can be removed again to recover exactly what discovery recorded", () => {
    const back = stripReviewLayer(augmented);
    // The marker's description is the reviewer's; everything else round-trips.
    expect(back.map((s) => s.type)).toEqual(recorded.map((s) => s.type));
    expect(JSON.stringify(back.map((s) => ("target" in s ? s.target : null)))).toBe(
      JSON.stringify(recorded.map((s) => ("target" in s ? s.target : null)))
    );
  });
});
