export interface HumanAction {
  ts: string;
  type: "click" | "fill";
  ref: string;
  label: string;
  value?: string;
}

// policy: confirm an irreversible step. task: something only a person may do.
// fault: automated recovery ran out. agent: the discovery model asked for help.
// policy and task are by design and don't count against reliability.
export type InterventionKind = "policy" | "task" | "fault" | "agent";

export type HandbackDecision = "continue" | "decline" | "timeout";

export interface InterventionRequest {
  id: string;
  runId: string;
  kind: InterventionKind;
  createdAt: string;
  timeoutAt: string;
  resolvedAt?: string;
  status: "open" | "resolved";
  decision?: HandbackDecision;
  capabilityName: string;
  goal: string;
  stepIndex: number;
  reason: string;
  screenshotFile: string;
  humanActions: HumanAction[];
}
