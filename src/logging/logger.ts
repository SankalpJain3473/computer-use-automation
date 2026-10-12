import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { maskKnownValues, redactDeep } from "../guardrails/redact.js";

export function evidenceRoot(): string {
  return path.join(process.cwd(), process.env.VITEST ? ".test-evidence" : "evidence");
}

export type LogListener = (event: string, data: Record<string, unknown>) => void;

export class RunLogger {
  readonly runDir: string;
  private readonly logPath: string;
  private readonly listeners: LogListener[] = [];
  private readonly masked: string[] = [];
  private readonly quiet: boolean;

  constructor(
    public readonly runId: string,
    public readonly kind: "discovery" | "replay",
    opts: { dir?: string; quiet?: boolean } = {}
  ) {
    this.runDir = opts.dir ?? path.join(evidenceRoot(), `${kind}-${runId}`);
    mkdirSync(this.runDir, { recursive: true });
    this.logPath = path.join(this.runDir, "log.jsonl");
    this.quiet = opts.quiet ?? false;
  }

  /** Listeners get raw events; disk and stdout only ever get scrubbed ones. */
  on(listener: LogListener): void {
    this.listeners.push(listener);
  }

  maskValues(values: string[]): void {
    this.masked.push(...values);
  }

  scrub<T>(data: T): T {
    return maskKnownValues(redactDeep(data), this.masked);
  }

  log(event: string, data: Record<string, unknown> = {}): void {
    const entry = this.scrub({ ts: new Date().toISOString(), event, ...data });
    appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf-8");
    for (const l of this.listeners) l(event, data);
    if (!this.quiet) console.log(`[${event}]`, JSON.stringify(this.scrub(data)).slice(0, 300));
  }

  async screenshot(page: Page, label: string): Promise<string> {
    const file = path.join(this.runDir, `${label}.png`);
    await page.screenshot({ path: file }).catch(() => undefined);
    return file;
  }

  writeJson(label: string, data: unknown): string {
    const file = path.join(this.runDir, `${label}.json`);
    writeFileSync(file, JSON.stringify(this.scrub(data), null, 2), "utf-8");
    return file;
  }
}

export function appendJsonLine(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(redactDeep(data)) + "\n", "utf-8");
}
