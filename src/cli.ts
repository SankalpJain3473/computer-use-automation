try {
  process.loadEnvFile();
} catch {
  // no .env file; settings may come from the environment
}

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { nanoid } from "nanoid";
import { CAPABILITIES, stripReviewLayer } from "./capabilities/definitions.js";
import { BASE_URL, bootstrapSession } from "./target-app-client.js";
import { RunLogger, evidenceRoot } from "./logging/logger.js";
import { SessionManager } from "./escalation/session-manager.js";
import { startOperatorServer } from "./escalation/operator-server.js";
import { runDiscovery } from "./llm/agent-loop.js";
import { currentModel } from "./llm/model.js";
import { saveArtifact, loadArtifact, listArtifacts } from "./artifact/store.js";
import type { Artifact, Step } from "./artifact/schema.js";
import { ArtifactContractError } from "./artifact/validate.js";
import { mayAutoConfirmIrreversible, artifactContainsIrreversibleStep } from "./guardrails/policy.js";
import { loadAllowlist } from "./guardrails/allowlist.js";
import { sensitiveValues } from "./guardrails/redact.js";
import { RunTracker } from "./runs/tracker.js";
import { startReplayRun } from "./runs/executor.js";
import { computeStats, readLedger, statsFor, type VersionStats } from "./runs/stats.js";
import { approveArtifact, revokeApproval, ApprovalRefused } from "./runs/approval.js";
import { createCapabilityApp } from "./server/app.js";
import { loadKeys } from "./server/auth.js";

const OPERATOR_PORT = Number(process.env.OPERATOR_PORT ?? 4174);
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 4180);
const headless = () => process.env.HEADLESS !== "false";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const kv = /^--([^=]+)=(.*)$/.exec(a);
    if (kv) out[kv[1]!] = kv[2]!;
    else if (/^--[^=]+$/.test(a)) out[a.slice(2)] = "true";
  }
  return out;
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

function nextVersion(name: string): number {
  const versions = listArtifacts()
    .filter((a) => a.name === name)
    .map((a) => a.version);
  return versions.length ? Math.max(...versions) + 1 : 1;
}

function paramsFor(artifactParams: { name: string }[], args: Record<string, string>, capName: string) {
  const params: Record<string, string> = {};
  for (const ip of artifactParams) {
    if (args[ip.name] === undefined) {
      fail(`Missing --${ip.name}=... for ${capName}`);
      return undefined;
    }
    params[ip.name] = args[ip.name]!;
  }
  return params;
}

function loadFromArgs(args: Record<string, string>): Artifact | undefined {
  try {
    return loadArtifact(args.capability ?? "", args.version ? Number(args.version) : undefined);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

function modeFrom(value: string | undefined, fallback: "live" | "rehearsal"): "live" | "rehearsal" | undefined {
  if (value === undefined) return fallback;
  if (value === "live" || value === "rehearsal") return value;
  fail(`--mode must be "live" or "rehearsal", not "${value}"`);
  return undefined;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

async function cmdDiscover(args: Record<string, string>) {
  const cap = CAPABILITIES[args.capability ?? ""];
  if (!cap) return fail(`Unknown capability "${args.capability}". Known: ${Object.keys(CAPABILITIES).join(", ")}`);
  const params = paramsFor(cap.inputParams, args, cap.name);
  if (!params) return;
  if (!process.env.OPENROUTER_API_KEY) return fail("OPENROUTER_API_KEY is not set (see .env.example).");

  const runId = nanoid(8);
  const logger = new RunLogger(runId, "discovery");
  logger.maskValues(sensitiveValues(cap.inputParams, params));
  const tracker = new RunTracker({ runId, kind: "discovery", capability: cap.name, mode: "discovery", invokedBy: "cli", params }, logger);
  logger.log("discovery.start", { capability: cap.name, params });

  const browser = await chromium.launch({ headless: headless() });
  const page = await (await browser.newContext()).newPage();
  const sessionManager = new SessionManager(page, logger);
  const operator = await startOperatorServer(sessionManager, OPERATOR_PORT);
  tracker.subscribe((r) => {
    if (r.state === "AWAITING_HUMAN") console.log(`\nWaiting for an operator: ${operator.url}\n`);
  });

  try {
    await bootstrapSession(page);
    await page.goto(`${BASE_URL}${cap.entryPath}`, { timeout: 15000 });
    const outcome = await runDiscovery({ goal: cap.goal(params), page, logger, sessionManager, capabilityName: cap.name, seedParams: params });
    logger.writeJson("discovery-outcome", outcome);
    await logger.screenshot(page, "final");
    tracker.finishDiscovery(outcome.success, outcome.summary);
    if (!outcome.success) return fail(`\nDiscovery did not succeed: ${outcome.summary}\nEvidence: ${logger.runDir}`);

    const artifact: Artifact = {
      schemaVersion: 1,
      id: `${cap.name}-${runId}`,
      name: cap.name,
      version: nextVersion(cap.name),
      description: cap.description,
      riskLevel: cap.riskLevel,
      target: { appName: "Meridian Teller Console", allowedOrigin: new URL(BASE_URL).origin, entryPathTemplate: cap.entryPath },
      inputParams: cap.inputParams,
      outputs: cap.outputs,
      successCheckpoint: cap.successCheckpoint,
      steps: cap.augment(outcome.recordedSteps),
      provenance: { recordedAt: new Date().toISOString(), discoveryRunId: runId, model: currentModel(), reviewedBy: null, approval: null },
    };
    try {
      const file = saveArtifact(artifact);
      logger.log("artifact.saved", { file, name: artifact.name, version: artifact.version });
      console.log(`\nSaved ${artifact.name} v${artifact.version} (draft): ${file}\nEvidence: ${logger.runDir}`);
    } catch (e) {
      if (!(e instanceof ArtifactContractError)) throw e;
      logger.writeJson("rejected-artifact", artifact);
      logger.log("artifact.rejected", { reason: e.message });
      fail(`\nRecording rejected: ${e.message}\nCandidate kept in ${logger.runDir}/rejected-artifact.json`);
    }
  } catch (err) {
    tracker.crash(err);
    throw err;
  } finally {
    operator.server.close();
    await browser.close();
  }
}

async function cmdReplay(args: Record<string, string>) {
  const artifact = loadFromArgs(args);
  if (!artifact) return;
  const params = paramsFor(artifact.inputParams, args, artifact.name);
  const mode = modeFrom(args.mode, "live");
  if (!params || !mode) return;

  const browser = await chromium.launch({ headless: headless() });
  try {
    const run = await startReplayRun({ browser, artifact, params, mode, invokedBy: "cli" });
    const operator = await startOperatorServer(run.sessionManager, OPERATOR_PORT);
    run.tracker.subscribe((r) => {
      if (r.state === "AWAITING_HUMAN") console.log(`\nWaiting for an operator: ${operator.url}\n`);
    });
    const result = await run.done;
    operator.server.close();
    console.log(`\nRun ${run.runId}: ${run.tracker.record.state}`);
    console.log(JSON.stringify(result, null, 2));
    console.log(`Evidence: ${run.tracker.record.evidenceDir}`);
    if (!result || result.status === "failure") process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

function printStats(rows: VersionStats[]) {
  if (!rows.length) {
    console.log("No replays recorded yet.");
    return;
  }
  const { minRuns, minConfidence } = loadAllowlist().approvalPolicy;
  console.log(`Approval needs >= ${minRuns} runs and >= ${pct(minConfidence)} confidence (Wilson 95% lower bound)\n`);
  console.table(
    rows.map((s) => ({
      capability: `${s.capability}@v${s.version}`,
      runs: s.runs,
      clean: s.clean,
      business: s.businessOutcomes,
      assisted: s.assisted,
      failed: s.failures,
      rehearsal: s.rehearsals,
      "raw rate": pct(s.successRate),
      confidence: pct(s.confidence),
      band: s.band,
      p50: s.p50Ms === null ? "-" : `${s.p50Ms}ms`,
      drift: s.driftRuns,
    }))
  );
}

async function cmdStability(args: Record<string, string>) {
  const artifact = loadFromArgs(args);
  if (!artifact) return;
  const params = paramsFor(artifact.inputParams, args, artifact.name);
  const irreversible = artifactContainsIrreversibleStep(artifact.steps);
  const mode = modeFrom(args.mode, irreversible ? "rehearsal" : "live");
  if (!params || !mode) return;
  const runs = Number(args.runs ?? 10);
  if (!Number.isInteger(runs) || runs < 1 || runs > 200) return fail("--runs must be a whole number from 1 to 200");
  if (mode === "live" && irreversible && !mayAutoConfirmIrreversible(artifact)) {
    return fail(`${artifact.name} pauses for a person at its irreversible step on every live run. Use --mode=rehearsal.`);
  }

  const dir = path.join(evidenceRoot(), `stability-${artifact.name}-v${artifact.version}-${nanoid(5)}`);
  console.log(`${runs} x ${artifact.name} v${artifact.version} (${mode}) -> ${dir}\n`);
  const browser = await chromium.launch({ headless: headless() });
  const outcomes: { i: number; runId: string; state: string; result: string; ms: number; drift: number }[] = [];
  try {
    for (let i = 1; i <= runs; i++) {
      const run = await startReplayRun({
        browser,
        artifact,
        params,
        mode,
        invokedBy: "stability",
        logDir: path.join(dir, `run-${String(i).padStart(2, "0")}`),
        quiet: true,
      });
      const result = await run.done;
      const rec = run.tracker.record;
      const summary = !result
        ? "harness error"
        : result.status === "business_outcome"
          ? result.code
          : result.status === "failure"
            ? `${result.errorCode} @ step ${result.stepIndex}`
            : result.status;
      const drift = rec.steps.filter((s) => s.driftStrategyIndex !== undefined).length;
      outcomes.push({ i, runId: run.runId, state: rec.state, result: summary, ms: rec.durationMs ?? 0, drift });
      console.log(`  run ${String(i).padStart(2)}  ${rec.state.padEnd(16)} ${summary.padEnd(22)} ${rec.durationMs}ms${drift ? `  drift x${drift}` : ""}`);
    }
  } finally {
    await browser.close();
  }

  const stats = statsFor(artifact.name, artifact.version);
  const { minRuns, minConfidence } = loadAllowlist().approvalPolicy;
  writeFileSync(
    path.join(dir, "report.json"),
    JSON.stringify({ artifact: `${artifact.name}@v${artifact.version}`, mode, runs: outcomes, cumulative: stats, policy: { minRuns, minConfidence } }, null, 2)
  );
  const md = [
    `# Stability: ${artifact.name} v${artifact.version}`,
    ``,
    `Mode: **${mode}**${mode === "rehearsal" ? " (stops before the irreversible step)" : ""}. Runs this sweep: ${runs}.`,
    ``,
    `| # | Run | State | Result | Duration | Drift |`,
    `|---|---|---|---|---|---|`,
    ...outcomes.map((o) => `| ${o.i} | ${o.runId} | ${o.state} | ${o.result} | ${o.ms} ms | ${o.drift} |`),
    ``,
    stats
      ? `All runs of this version: ${stats.runs} counted, ${pct(stats.successRate)} correct, confidence **${pct(stats.confidence)}** (${stats.band}). ` +
        `Approval needs ${minRuns}+ runs and ${pct(minConfidence)}+ confidence.`
      : "No counted runs for this version.",
  ].join("\n");
  writeFileSync(path.join(dir, "report.md"), md + "\n");

  console.log("");
  if (stats) printStats([stats]);
  console.log(
    stats?.band === "green"
      ? `\nEligible for approval: npm run approve -- --capability=${artifact.name} --reviewer="<your name>"`
      : `\nNot yet eligible for approval.`
  );
}

function cmdRevise(args: Record<string, string>) {
  const cap = CAPABILITIES[args.capability ?? ""];
  if (!cap) return fail(`Unknown capability "${args.capability}". Known: ${Object.keys(CAPABILITIES).join(", ")}`);
  let base: Artifact;
  try {
    base = loadArtifact(cap.name, args.from ? Number(args.from) : undefined);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const tracePath = path.join(evidenceRoot(), `discovery-${base.provenance.discoveryRunId}`, "discovery-outcome.json");
  let recordedSteps: Step[];
  try {
    recordedSteps = JSON.parse(readFileSync(tracePath, "utf-8")).recordedSteps;
  } catch {
    recordedSteps = stripReviewLayer(base.steps);
    console.log(`No discovery trace for v${base.version}; using the steps recorded in v${base.version} itself.`);
  }
  const version = nextVersion(cap.name);
  const revised: Artifact = {
    ...base,
    id: `${cap.name}-${base.provenance.discoveryRunId}-r${version}`,
    version,
    inputParams: cap.inputParams,
    outputs: cap.outputs,
    successCheckpoint: cap.successCheckpoint,
    steps: cap.augment(recordedSteps),
    provenance: { ...base.provenance, revisedFrom: base.version, reviewedBy: null, approval: null },
  };
  try {
    const file = saveArtifact(revised);
    console.log(`Saved ${cap.name} v${version} (draft, from v${base.version}): ${file}`);
    console.log(`Agents keep getting the current approved version until v${version} is approved.`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

function cmdApprove(args: Record<string, string>) {
  const name = args.capability ?? "";
  const version = args.version ? Number(args.version) : undefined;
  try {
    if (args.revoke === "true") {
      const a = revokeApproval(name, version);
      console.log(`Revoked approval for ${a.name} v${a.version}.`);
      return;
    }
    if (!args.reviewer) return fail('--reviewer="<name>" is required');
    const a = approveArtifact(name, args.reviewer, { version, unattendedIrreversible: args["allow-unattended-irreversible"] === "true" });
    const ap = a.provenance.approval!;
    console.log(`Approved ${a.name} v${a.version} (by ${a.provenance.reviewedBy}; ${ap.evidence.runs} ${ap.evidence.mode} runs, ${pct(ap.evidence.confidence)} confidence).`);
    if (a.riskLevel === "risky") {
      console.log(ap.unattendedIrreversible ? "Its irreversible step may run unattended." : "Its irreversible step still needs a person to confirm each time.");
    }
  } catch (e) {
    fail(e instanceof ApprovalRefused ? `Approval refused: ${e.message}` : e instanceof Error ? e.message : String(e));
  }
}

async function cmdServer() {
  let browser: Browser | undefined;
  const getBrowser = async () => (browser ??= await chromium.launch({ headless: headless() }));
  const host = process.env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && !(process.env.AGENT_API_KEY && process.env.OPERATOR_API_KEY)) {
    fail(`Listening on ${host} needs AGENT_API_KEY and OPERATOR_API_KEY set; generated keys would be unknown to anyone signing in.`);
    process.exit(1);
  }
  loadKeys();
  const { app } = createCapabilityApp(getBrowser);
  const server = app.listen(SERVER_PORT, host, () => {
    console.log(`Control center: http://localhost:${SERVER_PORT} (sign in with the operator key in .keys.json)`);
    console.log(`Agent API:      http://localhost:${SERVER_PORT}/api (Authorization: Bearer <agent key>)`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    fail(e.code === "EADDRINUSE" ? `Port ${SERVER_PORT} is in use. Stop the other server or set SERVER_PORT.` : e.message);
    process.exit(1);
  });
  const shutdown = async () => {
    server.close();
    await browser?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const USAGE = `Usage:
  npm run discover  -- --capability=<name> --<param>=<value> ...         record a capability with the LLM (draft)
  npm run replay    -- --capability=<name> [--version=N] [--mode=rehearsal] --<param>=<value> ...
  npm run stability -- --capability=<name> [--runs=10] [--mode=live|rehearsal] --<param>=<value> ...
  npm run stats                                                           reliability per version
  npm run revise    -- --capability=<name> [--from=N]                     new draft with the current checks
  npm run approve   -- --capability=<name> --reviewer="Name" [--version=N] [--allow-unattended-irreversible] [--revoke]
  npm run server                                                          agent API and control center

Capabilities: ${Object.keys(CAPABILITIES).join(", ")}`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case "discover":
      return cmdDiscover(args);
    case "replay":
      return cmdReplay(args);
    case "stability":
      return cmdStability(args);
    case "stats":
      return printStats(computeStats(readLedger()));
    case "revise":
      return cmdRevise(args);
    case "approve":
      return cmdApprove(args);
    case "server":
      return cmdServer();
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
