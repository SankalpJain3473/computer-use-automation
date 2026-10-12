import type { ElementHandle, Page } from "playwright";
import { nanoid } from "nanoid";
import { captureSnapshotWithHandles, type PageSnapshot } from "../perception/snapshot.js";
import type { RunLogger } from "../logging/logger.js";
import type { InterventionRequest, HumanAction, InterventionKind, HandbackDecision } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

// Automation and the operator take turns on the same live page; there is never a second session.
export class SessionManager {
  controller: "automation" | "human" = "automation";
  private current?: InterventionRequest;
  private snapshot?: PageSnapshot;
  private handles: Map<string, ElementHandle> = new Map();
  private resumeResolver?: (decision: HandbackDecision) => void;
  private timer?: NodeJS.Timeout;
  private readonly timeoutMs: number;

  constructor(
    public readonly page: Page,
    private readonly logger: RunLogger,
    opts: { timeoutMs?: number } = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.INTERVENTION_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  }

  getOpenRequest(): InterventionRequest | undefined {
    return this.current?.status === "open" ? this.current : undefined;
  }

  getSnapshot(): PageSnapshot | undefined {
    return this.snapshot;
  }

  async refreshSnapshot(): Promise<void> {
    const { snapshot, handles } = await captureSnapshotWithHandles(this.page);
    this.snapshot = snapshot;
    this.handles = handles;
  }

  async requestIntervention(args: {
    kind: InterventionKind;
    capabilityName: string;
    goal: string;
    stepIndex: number;
    reason: string;
  }): Promise<HandbackDecision> {
    this.controller = "human";
    await this.refreshSnapshot();
    const screenshotFile = await this.logger.screenshot(this.page, `intervention-${args.stepIndex}`);
    const req: InterventionRequest = {
      id: nanoid(8),
      runId: this.logger.runId,
      kind: args.kind,
      createdAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + this.timeoutMs).toISOString(),
      status: "open",
      capabilityName: args.capabilityName,
      goal: args.goal,
      stepIndex: args.stepIndex,
      reason: args.reason,
      screenshotFile,
      humanActions: [],
    };
    this.current = req;
    this.logger.log("intervention.requested", { ...req });

    return new Promise<HandbackDecision>((resolve) => {
      this.resumeResolver = resolve;
      // A run nobody answers would hold its browser session (and the app's login) forever.
      this.timer = setTimeout(() => {
        this.logger.log("intervention.timed_out", { id: req.id, afterMs: this.timeoutMs });
        this.resume("timeout");
      }, this.timeoutMs);
    });
  }

  async performHumanAction(action: { ref: string; type: "click" | "fill"; value?: string }): Promise<void> {
    if (!this.getOpenRequest()) throw new Error("No open intervention: automation is in control");
    const handle = this.handles.get(action.ref);
    if (!handle) throw new Error(`No live element for ref ${action.ref}; refresh the page view`);
    const label = this.snapshot?.elements.find((e) => e.ref === action.ref)?.name ?? action.ref;
    let secret = false;
    if (action.type === "click") {
      await handle.click();
      await this.page.waitForLoadState("load").catch(() => undefined);
    } else {
      const tag = String(await (await handle.getProperty("tagName")).jsonValue()).toLowerCase();
      const inputType = String(await (await handle.getProperty("type")).jsonValue()).toLowerCase();
      secret = inputType === "password";
      if (tag === "select") await handle.selectOption(action.value ?? "");
      else await handle.fill(action.value ?? "");
    }
    const entry: HumanAction = {
      ts: new Date().toISOString(),
      type: action.type,
      ref: action.ref,
      label,
      value: secret ? "[REDACTED]" : action.value,
    };
    this.current?.humanActions.push(entry);
    this.logger.log("intervention.human_action", { ...entry });
    await this.refreshSnapshot().catch(() => undefined);
  }

  resume(decision: HandbackDecision = "continue"): void {
    if (!this.getOpenRequest()) return;
    clearTimeout(this.timer);
    const current = this.current!;
    current.status = "resolved";
    current.resolvedAt = new Date().toISOString();
    current.decision = decision;
    this.logger.log("intervention.resumed", { id: current.id, decision });
    this.controller = "automation";
    this.resumeResolver?.(decision);
    this.resumeResolver = undefined;
  }
}
