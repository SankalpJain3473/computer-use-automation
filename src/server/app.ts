import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import type { Browser } from "playwright";
import type { Artifact } from "../artifact/schema.js";
import { listArtifacts, loadArtifact, loadLatestArtifacts, loadServingArtifact } from "../artifact/store.js";
import { createOperatorRouter } from "../escalation/operator-server.js";
import { loadAllowlist } from "../guardrails/allowlist.js";
import { redactDeep } from "../guardrails/redact.js";
import { computeStats, readLedger } from "../runs/stats.js";
import { TERMINAL_STATES } from "../runs/tracker.js";
import { THEME_CSS } from "../ui/theme.js";
import { clearOperatorCookie, loadKeys, requireRole, roleForKey, setOperatorCookie, type Keys } from "./auth.js";
import { catalogEntry, toolDefinitions, type CatalogEntry } from "./catalog.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { InvokeError, RunRegistry, type LiveRun } from "./registry.js";

const DEFAULT_WAIT_MS = 30_000;

export function createCapabilityApp(getBrowser: () => Promise<Browser>, keys: Keys = loadKeys()) {
  const app = express();
  const registry = new RunRegistry(getBrowser);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const agentOrOperator = requireRole(keys, "agent", "operator");
  const operatorOnly = requireRole(keys, "operator");

  const statsFor = () => computeStats(readLedger());
  const entryFor = (a: Artifact, stats = statsFor()) =>
    catalogEntry(a, stats.find((s) => s.capability === a.name && s.version === a.version));

  const agentCatalog = (): CatalogEntry[] => {
    const stats = statsFor();
    const names = [...new Set(listArtifacts().map((a) => a.name))].sort();
    return names
      .map((n) => loadServingArtifact(n))
      .filter((a): a is Artifact => !!a)
      .map((a) => entryFor(a, stats));
  };

  const operatorCatalog = () => {
    const stats = statsFor();
    return loadLatestArtifacts().map((a) => ({ ...entryFor(a, stats), servingVersion: loadServingArtifact(a.name)?.version ?? null }));
  };

  const runView = (run: LiveRun, extra: Record<string, unknown> = {}) => {
    const rec = run.tracker.record;
    const open = run.sessionManager.getOpenRequest();
    const terminal = TERMINAL_STATES.includes(rec.state);
    return {
      runId: rec.runId,
      capability: rec.capability,
      version: rec.version,
      state: rec.state,
      controller: rec.controller,
      ...extra,
      // The caller gets real outputs; anything persisted is redacted.
      result: terminal ? rec.result : undefined,
      intervention: open
        ? {
            id: open.id,
            kind: open.kind,
            stepIndex: open.stepIndex,
            reason: open.reason,
            operatorUrl: `/runs/${rec.runId}/operator/`,
          }
        : undefined,
      links: {
        self: `/api/runs/${rec.runId}`,
        operator: `/runs/${rec.runId}/operator/`,
        evidence: path.relative(process.cwd(), rec.evidenceDir),
      },
    };
  };

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/login", (req, res) => {
    res.type("html").send(loginPage(typeof req.query.next === "string" ? req.query.next : "/"));
  });
  app.post("/login", (req, res) => {
    const key = String(req.body?.key ?? "").trim();
    const next = typeof req.body?.next === "string" && req.body.next.startsWith("/") ? req.body.next : "/";
    const role = roleForKey(key, keys);
    if (role !== "operator") {
      res
        .status(401)
        .type("html")
        .send(loginPage(next, role === "agent" ? "Agent keys can't sign in here. Use the operator key." : "That key isn't recognised."));
      return;
    }
    setOperatorCookie(res, key);
    res.redirect(next);
  });
  app.get("/logout", (_req, res) => {
    clearOperatorCookie(res);
    res.redirect("/login");
  });

  app.get("/api/capabilities", agentOrOperator, (req, res, next) => {
    const role = res.locals.role;
    const format = req.query.format;
    if (format === "openai" || format === "anthropic") {
      res.json(toolDefinitions(agentCatalog(), format));
      return;
    }
    if (req.query.include === "drafts") {
      if (role !== "operator") return next(new InvokeError(403, "FORBIDDEN_FOR_ROLE", "Only operators can see drafts."));
      res.json(operatorCatalog());
      return;
    }
    res.json(agentCatalog());
  });

  app.get("/api/capabilities/:name", agentOrOperator, (req, res, next) => {
    const artifact = res.locals.role === "operator" ? safeLoad(req.params.name!) : loadServingArtifact(req.params.name!);
    if (!artifact) return next(new InvokeError(404, "UNKNOWN_CAPABILITY", `No capability named "${req.params.name}" is available to you`));
    res.json({
      ...entryFor(artifact),
      versions: listArtifacts()
        .filter((a) => a.name === artifact.name)
        .map((a) => a.version)
        .sort((x, y) => y - x),
      steps: artifact.steps.map((s, i) => ({ index: i, type: s.type, description: s.description })),
      provenance: artifact.provenance,
    });
  });

  app.post("/api/capabilities/:name/invoke", agentOrOperator, async (req, res, next) => {
    try {
      const role = res.locals.role as "agent" | "operator";
      const supervised = req.body?.supervised === true;
      if (supervised && role !== "operator") {
        throw new InvokeError(403, "SUPERVISED_REQUIRES_OPERATOR", "Only a signed-in operator can start a supervised run.");
      }
      const requested = req.body?.version !== undefined ? Number(req.body.version) : undefined;
      let artifact: Artifact | undefined;
      if (requested !== undefined) artifact = safeLoad(req.params.name!, requested);
      else artifact = supervised ? safeLoad(req.params.name!) : loadServingArtifact(req.params.name!);
      if (!artifact) {
        const exists = !!safeLoad(req.params.name!);
        throw exists
          ? new InvokeError(403, "CAPABILITY_NOT_APPROVED", `${req.params.name} has no approved version yet; agents can only invoke approved versions.`)
          : new InvokeError(404, "UNKNOWN_CAPABILITY", `No capability named "${req.params.name}"`);
      }
      const { run, idempotent } = await registry.invoke(artifact, {
        params: req.body?.params ?? {},
        idempotencyKey: req.body?.idempotencyKey ?? req.header("Idempotency-Key") ?? undefined,
        supervised,
        mode: req.body?.mode === "rehearsal" ? "rehearsal" : "live",
      });
      if (req.body?.wait !== false) {
        await registry.waitFor(run, "settled", Number(req.body?.timeoutMs ?? DEFAULT_WAIT_MS));
      }
      const terminal = TERMINAL_STATES.includes(run.tracker.record.state);
      res.status(terminal ? 200 : 202).json(runView(run, { idempotent }));
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/runs/:id", agentOrOperator, async (req, res, next) => {
    const role = res.locals.role;
    const run = registry.get(req.params.id!);
    if (!run || (role === "agent" && run.tracker.record.invokedBy !== "agent")) {
      const past = role === "operator" ? readLedger().find((e) => e.runId === req.params.id) : undefined;
      if (past) {
        res.json({ ...past, note: "Run finished before this server started; only the ledger summary is available." });
        return;
      }
      next(new InvokeError(404, "UNKNOWN_RUN", `No run ${req.params.id}`));
      return;
    }
    if (req.query.wait === "terminal" || req.query.wait === "settled") {
      await registry.waitFor(run, req.query.wait, Math.min(Number(req.query.timeoutMs ?? 25_000), 60_000));
    }
    res.json({ ...runView(run), record: redactDeep(run.tracker.record) });
  });

  app.get("/api/runs", operatorOnly, (_req, res) => {
    res.json(registry.list());
  });

  app.get("/api/interventions", operatorOnly, (_req, res) => {
    res.json(
      registry.openInterventions().map((i) => ({
        id: i.id,
        runId: i.runId,
        kind: i.kind,
        capability: i.capabilityName,
        stepIndex: i.stepIndex,
        reason: i.reason,
        createdAt: i.createdAt,
        operatorUrl: `/runs/${i.runId}/operator/`,
      }))
    );
  });

  app.get("/api/stats", operatorOnly, (_req, res) => {
    res.json(statsFor());
  });

  app.get("/api/policy", operatorOnly, (_req, res) => {
    res.json(loadAllowlist().approvalPolicy);
  });

  app.use(
    "/runs/:runId/operator",
    operatorOnly,
    (req, res, next) => {
      if (req.originalUrl.endsWith("/operator")) return res.redirect(301, req.originalUrl + "/");
      next();
    },
    createOperatorRouter((req) => registry.get(req.params.runId!)?.sessionManager)
  );

  app.get("/", operatorOnly, (_req, res) => {
    res.type("html").send(DASHBOARD_HTML);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof InvokeError) {
      const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (retry) res.setHeader("Retry-After", String(retry));
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "INVALID_JSON", message: "Request body is not valid JSON" });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "INTERNAL", message });
  });

  return { app, registry };
}

function safeLoad(name: string, version?: number): Artifact | undefined {
  try {
    return loadArtifact(name, version);
  } catch {
    return undefined;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function loginPage(next: string, error?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Sign in</title>
<style>${THEME_CSS}
.box{max-width:400px;margin:12vh auto 0;padding:0 16px}
.box .card-b{display:flex;flex-direction:column;gap:14px}
.err{background:var(--bad-soft);color:var(--bad);border-radius:8px;padding:9px 11px;font-size:13px}
input[type=password]{font:inherit;font-size:13px;border:1px solid var(--border-strong);border-radius:8px;padding:8px 10px;background:var(--card);color:var(--text)}
</style></head><body><div class="box">
<div class="brand" style="margin-bottom:16px"><div class="logo">C</div><div><h1>Control Center</h1><div class="sub">Meridian Teller Console</div></div></div>
<form class="card" method="POST" action="/login"><div class="card-b">
${error ? `<div class="err">${esc(error)}</div>` : ""}
<label class="field">Operator key<input type="password" name="key" autocomplete="current-password" autofocus required/></label>
<input type="hidden" name="next" value="${esc(next)}"/>
<button class="primary" type="submit">Sign in</button>
<p class="small muted" style="margin:0">Your operator key is in <span class="mono">.keys.json</span>.</p>
</div></form></div></body></html>`;
}
