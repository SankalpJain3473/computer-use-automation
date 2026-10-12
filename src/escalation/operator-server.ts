import express, { type Request } from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { SessionManager } from "./session-manager.js";
import { THEME_CSS, CLIENT_HELPERS } from "../ui/theme.js";

// Mounted standalone for a CLI run, or per run under /runs/:runId/operator/; the page uses relative URLs.
export function createOperatorRouter(resolve: (req: Request) => SessionManager | undefined): express.Router {
  const router = express.Router({ mergeParams: true });
  router.use(express.json());

  router.get("/", (_req, res) => {
    res.type("html").send(OPERATOR_HTML);
  });

  router.get("/api/state", (req, res) => {
    const sm = resolve(req);
    const open = sm?.getOpenRequest();
    if (!sm || !open) {
      res.json({ open: false, controller: sm?.controller ?? "automation" });
      return;
    }
    const snap = sm.getSnapshot();
    res.json({
      open: true,
      controller: sm.controller,
      id: open.id,
      runId: open.runId,
      kind: open.kind,
      capabilityName: open.capabilityName,
      stepIndex: open.stepIndex,
      reason: open.reason,
      createdAt: open.createdAt,
      timeoutAt: open.timeoutAt,
      humanActions: open.humanActions,
      url: snap?.url,
      elements: snap?.elements.map((e) => ({ ref: e.ref, role: e.role, name: e.name, secret: e.type === "password" })) ?? [],
    });
  });

  router.get("/api/screenshot", async (req, res) => {
    const sm = resolve(req);
    const open = sm?.getOpenRequest();
    if (!sm || !open) {
      res.status(404).end();
      return;
    }
    try {
      res.type("png").send(await sm.page.screenshot());
    } catch {
      try {
        res.type("png").send(readFileSync(open.screenshotFile));
      } catch {
        res.status(404).end();
      }
    }
  });

  router.post("/api/act", async (req, res) => {
    const sm = resolve(req);
    if (!sm?.getOpenRequest()) {
      res.status(409).json({ ok: false, error: "This run isn't waiting for you." });
      return;
    }
    const { ref, type, value } = req.body ?? {};
    if (typeof ref !== "string" || (type !== "click" && type !== "fill")) {
      res.status(400).json({ ok: false, error: "Expected { ref, type: 'click' | 'fill', value? }" });
      return;
    }
    try {
      await sm.performHumanAction({ ref, type, value: value === undefined ? undefined : String(value) });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.post("/api/refresh", async (req, res) => {
    const sm = resolve(req);
    if (sm) await sm.refreshSnapshot().catch(() => undefined);
    res.json({ ok: true });
  });

  router.post("/api/resume", (req, res) => {
    const sm = resolve(req);
    if (!sm?.getOpenRequest()) {
      res.status(409).json({ ok: false, error: "Nothing to resume." });
      return;
    }
    const decision = req.body?.decision === "decline" ? "decline" : "continue";
    sm.resume(decision);
    res.json({ ok: true, decision });
  });

  return router;
}

/** For a single CLI run. Moves to the next free port if the preferred one is taken. */
export async function startOperatorServer(sessionManager: SessionManager, port: number): Promise<{ server: Server; url: string }> {
  const app = express();
  app.use("/", createOperatorRouter(() => sessionManager));
  for (let p = port; p < port + 20; p++) {
    const server = await new Promise<Server | undefined>((resolve) => {
      const s = app.listen(p, "127.0.0.1", () => resolve(s));
      s.once("error", () => resolve(undefined));
    });
    if (server) return { server, url: `http://localhost:${p}` };
  }
  throw new Error(`No free port for the operator console in ${port}-${port + 19}`);
}

const OPERATOR_HTML = `<!doctype html>
<html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Operator</title>
<style>${THEME_CSS}
.reason{border-left:3px solid var(--warn);background:var(--warn-soft)}
.reason .badge{background:var(--card);border:1px solid var(--warn)}
.reason .lead{font-size:15px;font-weight:600;line-height:1.5;margin:6px 0 12px}
.meta{display:grid;grid-template-columns:minmax(0,2fr) repeat(4,minmax(0,1fr)) minmax(0,3fr);gap:12px 16px}
.meta b{display:block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:2px}
.meta span{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
@media (max-width:860px){.meta{grid-template-columns:repeat(2,minmax(0,1fr))}}
.grid{display:grid;grid-template-columns:1.25fr 1fr;gap:16px;margin-top:16px}
@media (max-width:860px){.grid{grid-template-columns:1fr}}
.grid .card + .card{margin-top:0}
#shot{display:block;width:100%;height:auto;background:var(--bg)}
.el{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border)}
.el:last-child{border-bottom:none}
.el .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.el input{width:130px}
.handback{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--bg);border-top:1px solid var(--border);flex-wrap:wrap}
.handback p{margin:0;flex:1;min-width:220px;font-size:12.5px;color:var(--muted)}
.idle{padding:56px 20px;text-align:center}
.idle .big{font-size:15px;font-weight:600;margin-bottom:6px}
#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:9px 14px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.show{opacity:.95}
</style></head>
<body><div class="wrap">
  <div class="topbar">
    <div class="brand"><div class="logo">&#9881;</div><div><h1>Operator</h1><div class="sub">Live session</div></div></div>
    <div class="spacer"></div>
    <a id="home" class="btn" href="/" style="display:none">&larr; Control center</a>
    <div class="live"><span class="dot" id="dot"></span><span id="ctl">connecting&hellip;</span></div>
  </div>

  <div id="idle" class="card"><div class="idle"><div class="big">Nothing waiting</div><div class="muted">This page updates when a run pauses.</div></div></div>

  <div id="panel" style="display:none">
    <div class="card reason"><div class="card-b">
      <span id="kind" class="badge warn"></span>
      <div class="lead" id="reasonMsg"></div>
      <div class="meta">
        <div><b>Capability</b><span id="mCap"></span></div>
        <div><b>Run</b><span id="mRun"></span></div>
        <div><b>Step</b><span id="mStep"></span></div>
        <div><b>Waiting</b><span id="mAge"></span></div>
        <div><b>Times out</b><span id="mDue"></span></div>
        <div><b>Page</b><span id="mUrl"></span></div>
      </div>
    </div></div>

    <div class="grid">
      <div class="card"><div class="card-h"><h2>Screen</h2></div><img id="shot" alt="Current screen"/></div>
      <div class="card"><div class="card-h"><h2>Controls</h2><span class="count" id="elCount"></span></div><div id="elements"></div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-h"><h2>Actions</h2></div>
      <div class="card-b"><pre class="code" id="actions">None yet</pre></div>
      <div class="handback"><p id="handbackHint"></p><button id="declineBtn">Decline</button><button class="primary" id="resumeBtn">Resume &rarr;</button></div>
    </div>
  </div>
</div>
<div id="toast"></div>
<script>${CLIENT_HELPERS}
if (location.pathname.startsWith('/runs/')) document.getElementById('home').style.display = '';
const KIND = {policy:'Confirmation required', task:'Action required', fault:'Automatic retries failed', agent:'Assistance requested'};
const HINT = {
  policy: 'Confirm on the page, then resume. Decline to cancel; nothing is changed.',
  task: 'Complete the step on the page, then resume. Password fields are never stored.',
  fault: 'Fix the problem on the page, then resume. Decline to stop the run.',
  agent: 'Take the next step on the page, then resume. Decline to stop the run.'
};
let lastSig = '';
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
function until(iso){const s=Math.max(0,Math.round((Date.parse(iso)-Date.now())/1000));return s<60?s+'s':Math.round(s/60)+'m'}
async function poll(){
  let r;
  try { r = await fetch('api/state').then(x=>x.json()); }
  catch { document.getElementById('dot').className='dot'; document.getElementById('ctl').textContent='Reconnecting\\u2026'; return; }
  document.getElementById('dot').className='dot on';
  document.getElementById('ctl').textContent = r.open ? 'You have control' : 'Automation running';
  document.getElementById('idle').style.display = r.open ? 'none' : '';
  document.getElementById('panel').style.display = r.open ? '' : 'none';
  if (!r.open) return;
  document.getElementById('kind').textContent = KIND[r.kind] || r.kind;
  document.getElementById('handbackHint').textContent = HINT[r.kind] || '';
  document.getElementById('reasonMsg').textContent = r.reason;
  document.getElementById('mCap').textContent = r.capabilityName;
  document.getElementById('mRun').textContent = r.runId;
  document.getElementById('mStep').textContent = r.stepIndex;
  document.getElementById('mAge').textContent = ago(r.createdAt);
  document.getElementById('mDue').textContent = 'in ' + until(r.timeoutAt);
  document.getElementById('mUrl').textContent = r.url || '';
  document.getElementById('shot').src = 'api/screenshot?_=' + Date.now();
  document.getElementById('actions').textContent = r.humanActions.length
    ? r.humanActions.map(a => a.ts.slice(11,19) + '  ' + a.type + '  ' + a.label + (a.value ? ' = ' + a.value : '')).join('\\n')
    : 'None yet';
  const sig = JSON.stringify(r.elements);
  if (sig === lastSig) return;
  lastSig = sig;
  document.getElementById('elCount').textContent = r.elements.length;
  const host = document.getElementById('elements');
  host.innerHTML = r.elements.length ? '' : '<div class="empty">No controls on this page.</div>';
  for (const e of r.elements) {
    const row = document.createElement('div'); row.className = 'el';
    row.innerHTML = '<span class="badge">' + esc(e.role) + '</span><span class="name" title="' + esc(e.name) + '">' + esc(e.name || e.ref) + '</span>';
    if (e.role === 'textbox' || e.role === 'combobox') {
      const input = document.createElement('input');
      input.type = e.secret ? 'password' : 'text';
      input.placeholder = e.secret ? 'Not stored' : 'Value';
      input.autocomplete = 'off';
      const fill = document.createElement('button'); fill.textContent = 'Fill';
      fill.onclick = () => act(e.ref, 'fill', input.value);
      row.append(input, fill);
    } else {
      const click = document.createElement('button'); click.textContent = 'Click';
      click.onclick = () => act(e.ref, 'click');
      row.append(click);
    }
    host.append(row);
  }
}
async function act(ref, type, value){
  const res = await fetch('api/act', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ref, type, value})});
  const body = await res.json();
  toast(body.ok ? (type === 'click' ? 'Clicked' : 'Filled') : (body.error || 'Action failed'));
  lastSig = ''; await poll();
}
async function handBack(decision){
  const res = await fetch('api/resume', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({decision})});
  toast(!res.ok ? 'Nothing to resume' : decision === 'decline' ? 'Declined' : 'Resumed');
  await poll();
}
document.getElementById('resumeBtn').onclick = () => handBack('continue');
document.getElementById('declineBtn').onclick = () => handBack('decline');
setInterval(poll, 1500); poll();
</script></body></html>`;
