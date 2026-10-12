import express from "express";
import { nanoid } from "nanoid";
import {
  members,
  flakyServed,
  createSubAccount,
  formatCents,
} from "./db.js";
import * as views from "./views.js";

const SESSION_TTL_MS = 10 * 60 * 1000;

interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
  acknowledged: Set<string>; // members whose compliance notice was acknowledged
  pendingSubAccount?: {
    memberId: string;
    accountType: string;
    initialDeposit: string;
    token: string;
    needsOverride: boolean;
    overrideApproved: boolean;
  };
}

const OVERRIDE_THRESHOLD = 10_000;
const SUPERVISOR_PIN = process.env.SUPERVISOR_PIN ?? "2468";
const sessions = new Map<string, Session>();

let skinName = process.env.TARGET_APP_SKIN ?? "standard";
const skin = () => views.SKINS[skinName] ?? views.SKINS.standard!;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  const cookie = req.headers.cookie ?? "";
  const match = /sid=([^;]+)/.exec(cookie);
  (req as any).sessionId = match?.[1];
  next();
});

function getSession(req: express.Request): Session | undefined {
  const sid = (req as any).sessionId;
  if (!sid) return undefined;
  const s = sessions.get(sid);
  if (!s) return undefined;
  if (Date.now() > s.expiresAt) {
    sessions.delete(sid);
    return undefined;
  }
  return s;
}

function requireSession(req: express.Request, res: express.Response): Session | undefined {
  const s = getSession(req);
  if (!s) {
    res.status(401).send(views.sessionExpiredPage());
    return undefined;
  }
  return s;
}

app.get("/login", (_req, res) => res.send(views.loginPage()));

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username !== "teller1" || password !== "demo") {
    res.status(401).send(views.loginPage("Invalid credentials."));
    return;
  }
  const sid = nanoid();
  sessions.set(sid, { id: sid, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS, acknowledged: new Set() });
  res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Path=/`);
  res.redirect("/members/search");
});

app.get("/logout", (req, res) => {
  const sid = (req as any).sessionId;
  if (sid) sessions.delete(sid);
  res.setHeader("Set-Cookie", "sid=; Max-Age=0; Path=/");
  res.redirect("/login");
});

app.get("/members/search", (req, res) => {
  if (!requireSession(req, res)) return;
  res.send(views.searchPage(skin()));
});

app.post("/members/search", (req, res) => {
  if (!requireSession(req, res)) return;
  const memberId = String(req.body.memberId ?? "").trim();
  res.redirect(`/members/${encodeURIComponent(memberId)}`);
});

app.get("/members/:id", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const id = req.params.id;
  const m = members.get(id);
  if (!m) {
    res.status(404).send(views.notFoundPage(id));
    return;
  }
  if (m.restricted) {
    res.status(403).send(views.permissionDeniedPage(id));
    return;
  }
  if (m.expiresSession) {
    sessions.delete(session.id);
    res.status(401).send(views.sessionExpiredPage());
    return;
  }
  const flakyKey = `${session.id}:${id}`;
  const served = flakyServed.get(flakyKey) ?? 0;
  if (m.flakyFailures && served < m.flakyFailures) {
    flakyServed.set(flakyKey, served + 1);
    res.status(504).send(views.transientErrorPage(id));
    return;
  }
  if (m.complianceNotice && !session.acknowledged.has(id)) {
    res.send(views.complianceNoticePage(id));
    return;
  }
  res.send(
    views.memberDetailPage(skin(), {
      id: m.id,
      name: m.name,
      savings: formatCents(m.savingsBalanceCents),
      checking: formatCents(m.checkingBalanceCents),
    })
  );
});

app.get("/members/:id/new-subaccount", (req, res) => {
  if (!requireSession(req, res)) return;
  const id = req.params.id;
  if (!members.has(id)) {
    res.status(404).send(views.notFoundPage(id));
    return;
  }
  res.send(views.newSubAccountFormPage(id));
});

app.post("/members/:id/new-subaccount", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const id = req.params.id;
  if (!members.has(id)) {
    res.status(404).send(views.notFoundPage(id));
    return;
  }
  const accountType = String(req.body.accountType ?? "");
  const initialDeposit = String(req.body.initialDeposit ?? "").trim();
  const amount = Number(initialDeposit.replace(/[^0-9.]/g, ""));
  if (!initialDeposit || Number.isNaN(amount) || amount < 25) {
    res
      .status(422)
      .send(views.newSubAccountFormPage(id, "Initial deposit must be a number of at least $25.00."));
    return;
  }
  const token = nanoid(8);
  const needsOverride = amount >= OVERRIDE_THRESHOLD;
  session.pendingSubAccount = { memberId: id, accountType, initialDeposit, token, needsOverride, overrideApproved: false };
  if (needsOverride) {
    res.send(views.supervisorOverridePage(id, initialDeposit));
    return;
  }
  res.send(views.confirmSubAccountPage({ memberId: id, accountType, initialDeposit, token }));
});

app.post("/members/:id/new-subaccount/override", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const id = req.params.id;
  const pending = session.pendingSubAccount;
  if (!pending || pending.memberId !== id || !pending.needsOverride) {
    res.status(409).send(views.newSubAccountFormPage(id, "No pending request needs an override. Please start again."));
    return;
  }
  if (String(req.body.supervisorPin ?? "") !== SUPERVISOR_PIN) {
    res.send(views.supervisorOverridePage(id, pending.initialDeposit, "Supervisor PIN not accepted."));
    return;
  }
  pending.overrideApproved = true;
  res.send(
    views.confirmSubAccountPage({ memberId: id, accountType: pending.accountType, initialDeposit: pending.initialDeposit, token: pending.token })
  );
});

app.post("/members/:id/new-subaccount/confirm", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const id = req.params.id;
  const pending = session.pendingSubAccount;
  const token = String(req.body.token ?? "");
  if (!pending || pending.memberId !== id || pending.token !== token) {
    res.status(409).send(views.newSubAccountFormPage(id, "Confirmation expired or invalid. Please start again."));
    return;
  }
  if (pending.needsOverride && !pending.overrideApproved) {
    res.status(403).send(views.supervisorOverridePage(id, pending.initialDeposit, "Supervisor override has not been approved."));
    return;
  }
  const amount = Math.round(Number(pending.initialDeposit.replace(/[^0-9.]/g, "")) * 100);
  const acct = createSubAccount(id, pending.accountType, amount);
  session.pendingSubAccount = undefined;
  res.send(views.subAccountSuccessPage({ memberId: id, accountNumber: acct.accountNumber }));
});

app.post("/members/:id/acknowledge", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  session.acknowledged.add(req.params.id);
  res.redirect(`/members/${encodeURIComponent(req.params.id)}`);
});

// Test hook: present another tenant's configuration of the same product.
app.get("/debug/skin", (_req, res) => {
  res.json({ skin: skinName, available: Object.keys(views.SKINS) });
});
app.post("/debug/skin", express.json(), (req, res) => {
  const name = String(req.body?.skin ?? req.query.skin ?? "");
  if (!views.SKINS[name]) {
    res.status(400).json({ error: `unknown skin "${name}"`, available: Object.keys(views.SKINS) });
    return;
  }
  skinName = name;
  res.json({ skin: skinName });
});

const port = Number(process.env.TARGET_APP_PORT ?? 4173);
app.listen(port, () => {
  console.log(`[target-app] Meridian Teller Console listening on http://localhost:${port}`);
});
