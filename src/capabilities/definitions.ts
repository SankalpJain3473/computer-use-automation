import type { Step, InputParam, OutputField, CheckpointCondition } from "../artifact/schema.js";

// Per-capability goal wording, contract, and the checks layered onto a recorded run.
export interface CapabilityDef {
  name: string;
  description: string;
  riskLevel: "safe" | "risky";
  entryPath: string;
  goal(params: Record<string, string>): string;
  inputParams: InputParam[];
  outputs: OutputField[];
  successCheckpoint: CheckpointCondition;
  augment(rawSteps: Step[]): Step[];
}

const ADDED_EXTRACT_DESCRIPTION = "Read the newly created account number off the success screen";

/** Undoes augment(), for revising an artifact whose discovery trace is gone. */
export function stripReviewLayer(steps: Step[]): Step[] {
  return steps
    .filter((s) => s.type !== "checkOutcomes")
    .filter((s) => !(s.type === "extract" && s.description === ADDED_EXTRACT_DESCRIPTION))
    .map((s) => (s.type === "confirmIrreversible" ? { type: "click" as const, target: s.target, description: s.description } : s));
}

function findClickIndexByName(steps: Step[], name: string): number {
  const needle = name.toLowerCase();
  return steps.findIndex((s) => {
    if (s.type !== "click" && s.type !== "confirmIrreversible") return false;
    return s.target.strategies.some(
      (strat) => (strat.kind === "role" && strat.name.toLowerCase().includes(needle)) || (strat.kind === "text" && strat.text.toLowerCase().includes(needle))
    );
  });
}

const MEMBER_RECORD_OUTCOMES: Step = {
  type: "checkOutcomes",
  description: "Check the member record loaded",
  outcomes: [
    { code: "MEMBER_NOT_FOUND", category: "business_outcome", description: "No member record exists for the given ID", detect: { kind: "httpStatus", status: 404 } },
    {
      code: "PERMISSION_DENIED",
      category: "business_outcome",
      description: "This teller role is not authorized to view a restricted member",
      detect: { kind: "httpStatus", status: 403 },
    },
    {
      code: "CORE_TIMEOUT",
      category: "recoverable",
      description: "Core banking service timed out loading the member record",
      detect: { kind: "httpStatus", status: 504 },
      recovery: { action: "reload", maxAttempts: 2, waitMs: 1000 },
    },
    {
      code: "COMPLIANCE_NOTICE",
      category: "recoverable",
      description: "A compliance notice must be acknowledged before the record is shown",
      detect: { kind: "textVisible", text: "Compliance notice" },
      recovery: {
        action: "dismiss",
        target: { strategies: [{ kind: "role", role: "button", name: "Acknowledge and Continue", exact: true }] },
        maxAttempts: 1,
        waitMs: 0,
      },
    },
    {
      code: "SESSION_EXPIRED",
      category: "failure",
      description: "Session expired mid-flow; re-authenticate and retry",
      detect: { kind: "httpStatus", status: 401 },
    },
  ],
};

const SUBACCOUNT_FORM_OUTCOMES: Step = {
  type: "checkOutcomes",
  description: "Check the request was accepted",
  outcomes: [
    {
      code: "VALIDATION_ERROR",
      category: "business_outcome",
      description: "Initial deposit did not meet the minimum required amount",
      detect: { kind: "httpStatus", status: 422 },
    },
    {
      code: "SUPERVISOR_OVERRIDE",
      category: "recoverable",
      description: "A deposit this large needs a supervisor's override",
      detect: { kind: "textVisible", text: "Supervisor override required" },
      recovery: {
        action: "human",
        instruction: "A supervisor enters their PIN on this page and clicks Approve Override.",
        maxAttempts: 1,
        waitMs: 0,
      },
    },
  ],
};

export const CAPABILITIES: Record<string, CapabilityDef> = {
  lookup_member_balance: {
    name: "lookup_member_balance",
    description: "Look up a member by ID and read their current savings and checking balances.",
    riskLevel: "safe",
    entryPath: "/members/search",
    goal: (p) => `Look up member ${p.memberId} and read their current savings and checking balance.`,
    inputParams: [{ name: "memberId", type: "string", description: "The member ID to look up", required: true, pattern: "^\\d+$", sensitive: true }],
    outputs: [
      { name: "savings_balance", type: "string", description: "Current savings balance, formatted as currency" },
      { name: "checking_balance", type: "string", description: "Current checking balance, formatted as currency" },
    ],
    // Path only, so the same artifact works against any tenant's host.
    successCheckpoint: { kind: "urlMatches", pattern: "/members/[^/]+$" },
    augment(rawSteps) {
      const steps = [...rawSteps];
      const search = findClickIndexByName(steps, "Look Up Member");
      if (search >= 0) steps.splice(search + 1, 0, MEMBER_RECORD_OUTCOMES);
      return steps;
    },
  },

  open_member_subaccount: {
    name: "open_member_subaccount",
    description: "Open a new sub-account for an existing member with a given initial deposit, and return the new account number.",
    riskLevel: "risky",
    entryPath: "/members/search",
    goal: (p) =>
      `Open a new savings sub-account for member ${p.memberId} with an initial deposit of $${p.initialDeposit}. Proceed all the way through the confirmation step to finish opening the account, then read and report the new account number shown on the resulting screen.`,
    inputParams: [
      { name: "memberId", type: "string", description: "The member ID to open the sub-account for", required: true, pattern: "^\\d+$", sensitive: true },
      { name: "initialDeposit", type: "string", description: 'Initial deposit in USD, e.g. "50.00"', required: true, pattern: "^\\d+(\\.\\d{1,2})?$" },
    ],
    outputs: [{ name: "new_account_number", type: "string", description: "The new sub-account's account number" }],
    successCheckpoint: { kind: "textVisible", text: "New Account Number" },
    augment(rawSteps) {
      const steps = [...rawSteps];

      const search = findClickIndexByName(steps, "Look Up Member");
      if (search >= 0) steps.splice(search + 1, 0, MEMBER_RECORD_OUTCOMES);

      const cont = findClickIndexByName(steps, "Continue");
      if (cont >= 0) steps.splice(cont + 1, 0, SUBACCOUNT_FORM_OUTCOMES);

      const confirm = findClickIndexByName(steps, "Confirm and Open Account");
      if (confirm >= 0) {
        const step = steps[confirm]!;
        if (step.type === "click") {
          steps[confirm] = { type: "confirmIrreversible", target: step.target, description: "Confirm opening the new sub-account" };
        }
        // Discovery may report the number in prose without recording an extract step.
        if (!steps.some((s) => s.type === "extract" && s.outputName === "new_account_number")) {
          steps.splice(confirm + 1, 0, {
            type: "extract",
            target: { strategies: [{ kind: "tableCellByRowLabel", labelText: "New Account Number" }] },
            outputName: "new_account_number",
            transform: "trim",
            description: ADDED_EXTRACT_DESCRIPTION,
          });
        }
      }
      return steps;
    },
  },
};
