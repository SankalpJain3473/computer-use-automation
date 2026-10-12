import { THEME_CSS, CLIENT_HELPERS } from "../ui/theme.js";

// The page is a TS template string, so client code avoids template literals.
export const DASHBOARD_HTML = `<!doctype html>
<html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Control Center</title>
<style>${THEME_CSS}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
@media (max-width:820px){.kpis{grid-template-columns:repeat(2,1fr)}}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px}
.kpi .label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.kpi .value{font-size:26px;font-weight:700;letter-spacing:-.02em;margin-top:4px}
.kpi .hint{font-size:12px;color:var(--muted);margin-top:2px}
.kpi.alert{border-color:var(--warn);background:var(--warn-soft)}
.kpi.alert .value{color:var(--warn)}
.cap-name{font-weight:650}
td.mono,td .mono{white-space:nowrap}
.cap-desc{font-size:12.5px;color:var(--muted);margin-top:2px;max-width:420px}
.rel{display:flex;flex-direction:column;gap:4px}
.rel .line{display:flex;align-items:center;gap:8px}
.form-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;padding:12px 16px 14px;background:var(--bg);border-top:1px solid var(--border)}
.form-row .note{flex-basis:100%;font-size:12px;color:var(--muted);margin:0}
.inbox-row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border)}
.inbox-row:last-child{border-bottom:none}
.inbox-row .what{flex:1;min-width:0}
.inbox-row .what b{font-weight:650}
.inbox-row .why{font-size:12.5px;color:var(--muted);margin-top:2px}
.detail{padding:14px 16px;background:var(--bg);border-top:1px solid var(--border)}
.seg{display:flex;gap:2px;background:var(--idle-soft);border-radius:8px;padding:2px;flex-wrap:wrap}
.seg button{border:0;background:transparent;font-size:12px;padding:4px 10px;border-radius:6px;box-shadow:none}
.seg button.on{background:var(--card);box-shadow:0 1px 2px rgba(0,0,0,.08);font-weight:600}
.more{padding:10px 16px;border-top:1px solid var(--border);text-align:center}
.timeline{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 12px}
.timeline .arrow{color:var(--muted);font-size:12px}
.steps{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
.step{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:7px 9px;font-size:12px}
.step b{font-family:var(--mono);font-size:11.5px}
.step.drift{border-color:var(--warn)}
.detail h3{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:12px 0 6px}
.detail h3:first-child{margin-top:0}
details summary{cursor:pointer;padding:12px 16px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);list-style:none}
details summary::-webkit-details-marker{display:none}
details[open] summary{border-bottom:1px solid var(--border)}
#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:9px 14px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;max-width:90vw}
#toast.show{opacity:.95}
</style></head>
<body><div class="wrap">
  <div class="topbar">
    <div class="brand"><div class="logo">C</div><div><h1>Control Center</h1><div class="sub">Meridian Teller Console</div></div></div>
    <div class="spacer"></div>
    <div class="live"><span class="dot" id="dot"></span><span id="liveText">connecting&hellip;</span></div>
    <span class="badge accent">Operator</span>
    <a class="btn" href="/logout">Sign out</a>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="label">Capabilities</div><div class="value" id="kCaps">&ndash;</div><div class="hint" id="kCapsHint"></div></div>
    <div class="kpi" id="kWaitTile"><div class="label">Waiting on you</div><div class="value" id="kWait">&ndash;</div><div class="hint">paused runs</div></div>
    <div class="kpi"><div class="label">Runs recorded</div><div class="value" id="kRuns">&ndash;</div><div class="hint" id="kRunsHint"></div></div>
    <div class="kpi"><div class="label">Success rate</div><div class="value" id="kRate">&ndash;</div><div class="hint">including business outcomes</div></div>
  </div>

  <div class="card" id="inboxCard">
    <div class="card-h"><h2>Inbox</h2><span class="count" id="inboxCount">0</span></div>
    <div id="inbox"><div class="empty">Nothing waiting.</div></div>
  </div>

  <div class="card">
    <div class="card-h"><h2>Capabilities</h2><span class="spacer"></span><span class="small muted" id="policyText"></span></div>
    <div id="caps"><div class="empty">Loading&hellip;</div></div>
  </div>

  <div class="card">
    <div class="card-h"><h2>Runs</h2><span class="count" id="runCount">0</span><span class="spacer"></span><div class="seg" id="runFilter"></div></div>
    <div id="runs"><div class="empty">No runs yet.</div></div>
  </div>

  <div class="card">
    <details id="toolsBox"><summary>Agent tool definitions</summary>
      <div class="card-b"><pre class="code" id="tools">loading&hellip;</pre></div>
    </details>
  </div>
</div>
<div id="toast"></div>
<script>${CLIENT_HELPERS}
let policy = {minRuns: 8, minConfidence: 0.7};
let openForm = null, openRun = null, capsSig = '', runFilter = 'all', runLimit = 15;
const BAND = {green:['ok','Proven'], amber:['warn','Watch'], red:['bad','Unreliable'], insufficient:['','Not enough runs']};
const KIND = {policy:'Confirmation', task:'Action required', fault:'Retries failed', agent:'Assistance'};

function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600)}
async function getJSON(u){const r=await fetch(u);if(r.status===401){location.href='/login';throw new Error('signed out')}return r.json()}

function relCell(c){
  const r = c.reliability;
  if (!r || !r.runs) return '<span class="muted small">no runs yet</span>';
  const b = BAND[r.band] || ['',''];
  const pct = Math.round(r.confidence * 100);
  return '<div class="rel"><div class="line"><span class="meter ' + b[0] + '"><span style="width:' + pct + '%"></span></span><span class="mono">' + pct + '%</span><span class="badge ' + b[0] + '">' + b[1] + '</span></div>'
    + '<span class="small muted">' + r.runs + ' runs &middot; ' + Math.round(r.successRate*100) + '% raw &middot; p50 ' + ms(r.p50Ms) + (r.driftRuns ? ' &middot; <span style="color:var(--warn)">' + r.driftRuns + ' drift</span>' : '') + '</span></div>';
}

function renderCaps(caps){
  const sig = JSON.stringify(caps) + openForm;
  if (sig === capsSig) return; capsSig = sig;
  const host = document.getElementById('caps');
  if (!caps.length) { host.innerHTML = '<div class="empty">No capabilities yet.</div>'; return; }
  let html = '<table><thead><tr><th>Capability</th><th>Ver</th><th>Risk</th><th>Approval</th><th>Reliability</th><th></th></tr></thead><tbody>';
  for (const c of caps) {
    const appr = c.approval.state === 'approved'
      ? '<span class="badge ok">Approved</span><div class="small muted" style="margin-top:3px">by ' + esc(c.approval.reviewedBy) + (c.pausesForHuman ? ' &middot; confirmation required' : '') + '</div>'
      : '<span class="badge">Draft</span><div class="small muted" style="margin-top:3px">' + (c.servingVersion ? 'agents use v' + c.servingVersion : 'not available to agents') + '</div>';
    const risk = c.riskLevel === 'risky' ? '<span class="badge warn">Irreversible</span>' : '<span class="badge info">Read-only</span>';
    html += '<tr><td><div class="cap-name mono">' + esc(c.name) + '</div><div class="cap-desc">' + esc(c.description) + '</div></td>'
      + '<td class="mono">v' + c.version + '</td><td>' + risk + '</td><td>' + appr + '</td><td>' + relCell(c) + '</td>'
      + '<td style="text-align:right"><button data-run="' + esc(c.name) + '">' + (openForm === c.name ? 'Close' : 'Run&hellip;') + '</button></td></tr>';
    if (openForm === c.name) {
      html += '<tr><td colspan="6" style="padding:0"><form class="form-row" data-form="' + esc(c.name) + '">';
      for (const [k, p] of Object.entries(c.inputSchema.properties)) {
        html += '<label class="field">' + esc(k) + '<input type="text" name="' + esc(k) + '" placeholder="' + esc(p.description) + '" required/></label>';
      }
      html += '<label class="field">Mode<select name="__mode"><option value="live">live</option><option value="rehearsal">rehearsal</option></select></label>'
        + '<button class="primary" type="submit">Run</button>'
        + '<p class="note">Irreversible steps wait for your confirmation.</p></form></td></tr>';
    }
  }
  host.innerHTML = html + '</tbody></table>';
  host.querySelectorAll('button[data-run]').forEach(b => b.onclick = () => { openForm = openForm === b.dataset.run ? null : b.dataset.run; capsSig=''; refresh(); });
  host.querySelectorAll('form[data-form]').forEach(f => f.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(f); const params = {}; let mode = 'live';
    for (const [k, v] of fd.entries()) { if (k === '__mode') mode = v; else params[k] = v; }
    const res = await fetch('/api/capabilities/' + f.dataset.form + '/invoke', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({params, supervised:true, mode, wait:false})});
    const body = await res.json();
    if (!res.ok) { toast(body.message || body.error); return; }
    toast('Started run ' + body.runId); openForm = null; openRun = body.runId; capsSig = ''; refresh();
  });
}

function renderInbox(items){
  document.getElementById('inboxCount').textContent = items.length;
  document.getElementById('inboxCard').style.borderColor = items.length ? 'var(--warn)' : '';
  const host = document.getElementById('inbox');
  if (!items.length) { host.innerHTML = '<div class="empty">Nothing waiting.</div>'; return; }
  host.innerHTML = items.map(i => '<div class="inbox-row"><span class="badge warn pulse">' + esc(KIND[i.kind] || i.kind) + '</span>'
    + '<div class="what"><b class="mono">' + esc(i.capability) + '</b> <span class="muted small">run ' + esc(i.runId) + ' &middot; step ' + i.stepIndex + ' &middot; waiting ' + ago(i.createdAt) + '</span><div class="why">' + esc(i.reason) + '</div></div>'
    + '<a class="btn primary" href="' + esc(i.operatorUrl) + '">Take over &rarr;</a></div>').join('');
}

function resultText(r){
  if (!r) return '';
  if (r.status === 'success') return Object.keys(r.outputs||{}).length ? Object.entries(r.outputs).map(([k,v]) => k + '=' + v).join(', ') : 'success';
  if (r.status === 'business_outcome') return r.code;
  if (r.status === 'failure') return r.errorCode + ' at step ' + r.stepIndex;
  if (r.status === 'rehearsal_complete') return 'rehearsal stopped before step ' + r.stoppedBeforeStep;
  return r.status || '';
}

async function renderDetail(runId){
  const box = document.getElementById('detail-' + runId);
  if (!box) return;
  const d = await getJSON('/api/runs/' + runId);
  const rec = d.record;
  if (!rec) {
    box.innerHTML = '<h3>Summary</h3><div class="timeline">' + stateBadge(d.state) + '<span class="small mono">' + esc(d.code || d.resultStatus || '') + '</span></div>'
      + '<div class="small muted" style="margin-top:8px">' + (d.interventionKinds && d.interventionKinds.length ? 'Handoffs: ' + d.interventionKinds.map(k => esc(KIND[k] || k)).join(', ') + ' &middot; ' : '')
      + (d.driftSteps ? d.driftSteps + ' drifted step(s) &middot; ' : '') + 'ended ' + ago(d.endedAt) + '</div>'
      + '<div class="small muted" style="margin-top:6px">Step-level detail is in the run\\'s evidence folder.</div>';
    return;
  }
  let html = '<h3>State transitions</h3><div class="timeline">';
  rec.transitions.forEach((t, i) => { html += (i ? '<span class="arrow">&rarr;</span>' : '') + stateBadge(t.to) + '<span class="small muted">' + t.at.slice(11,19) + '</span>'; });
  html += '</div>';
  if (rec.steps.length) {
    html += '<h3>Steps (' + esc(rec.phase || '') + ' phase last)</h3><div class="steps">' + rec.steps.map(s => '<div class="step' + (s.driftStrategyIndex !== undefined ? ' drift' : '') + '"><b>#' + s.index + '</b> ' + esc(s.type) + '<div class="muted">' + ms(s.durationMs) + (s.driftStrategyIndex !== undefined ? ' &middot; fallback locator #' + s.driftStrategyIndex : '') + '</div></div>').join('') + '</div>';
  }
  if (rec.interventions.length) {
    html += '<h3>Human handoffs</h3>' + rec.interventions.map(i => '<div class="small"><span class="badge warn">' + esc(KIND[i.kind] || i.kind) + '</span> step ' + i.stepIndex + ' &middot; ' + i.humanActions + ' human action(s) &middot; ' + (i.resolvedAt ? 'handed back ' + ago(i.resolvedAt) : '<b>still open</b> &middot; <a href="' + d.links.operator + '">take over</a>') + '<div class="muted" style="margin:3px 0 6px">' + esc(i.reason) + '</div></div>').join('');
  }
  if (rec.result) html += '<h3>Result</h3><pre class="code">' + esc(JSON.stringify(rec.result, null, 2)) + '</pre>';
  html += '<div class="small muted" style="margin-top:10px">Evidence: <span class="mono">' + esc(d.links.evidence) + '</span></div>';
  box.innerHTML = html;
}

function renderRuns(data){
  const rows = data.live.map(r => ({id:r.runId, cap:r.capability, v:r.version, state:r.state, by:r.invokedBy, mode:r.mode, at:r.startedAt, dur:r.durationMs, res:resultText(r.result), live:true}))
    .concat(data.history.map(e => ({id:e.runId, cap:e.capability, v:e.version, state:e.state, by:e.invokedBy, mode:e.mode, at:e.endedAt, dur:e.durationMs, res:e.code || e.resultStatus || '', live:false})));
  document.getElementById('runCount').textContent = rows.length;
  const counts = {all: rows.length};
  rows.forEach(r => { counts[r.by] = (counts[r.by] || 0) + 1; });
  const seg = document.getElementById('runFilter');
  seg.innerHTML = ['all', 'agent', 'operator', 'scenario'].filter(k => k === 'all' || counts[k])
    .map(k => '<button data-f="' + k + '" class="' + (runFilter === k ? 'on' : '') + '">' + (k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)) + ' <span class="muted">' + (counts[k] || 0) + '</span></button>').join('');
  seg.querySelectorAll('button').forEach(b => b.onclick = () => { runFilter = b.dataset.f; runLimit = 15; refresh(); });
  const shown = rows.filter(r => runFilter === 'all' || r.by === runFilter);
  const host = document.getElementById('runs');
  if (!shown.length) { host.innerHTML = '<div class="empty">No runs yet.</div>'; return; }
  let html = '<table><thead><tr><th>State</th><th>Capability</th><th>Who</th><th>Mode</th><th>When</th><th>Took</th><th>Result</th></tr></thead><tbody>';
  for (const r of shown.slice(0, runLimit)) {
    html += '<tr class="clickable" data-id="' + esc(r.id) + '"><td>' + stateBadge(r.state) + '</td><td><span class="mono">' + esc(r.cap) + '</span> ' + (r.v != null ? '<span class="muted small">v' + r.v + '</span>' : '<span class="muted small">discovery</span>') + '<div class="small muted mono">' + esc(r.id) + '</div></td>'
      + '<td class="small">' + esc(r.by) + '</td><td class="small">' + esc(r.mode) + '</td><td class="small muted" style="white-space:nowrap">' + ago(r.at) + '</td><td class="small mono">' + ms(r.dur) + '</td><td class="small mono">' + esc(r.res) + '</td></tr>';
    if (openRun === r.id) html += '<tr><td colspan="7" style="padding:0"><div class="detail" id="detail-' + esc(r.id) + '"><span class="small muted">loading&hellip;</span></div></td></tr>';
  }
  html += '</tbody></table>';
  if (shown.length > runLimit) html += '<div class="more"><button id="moreRuns">Show more (' + (shown.length - runLimit) + ' older)</button></div>';
  host.innerHTML = html;
  const more = document.getElementById('moreRuns');
  if (more) more.onclick = () => { runLimit += 25; refresh(); };
  host.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => { openRun = openRun === tr.dataset.id ? null : tr.dataset.id; refresh(); });
  if (openRun) renderDetail(openRun);
}

async function refresh(){
  try {
    const [caps, runs, inbox, tools] = await Promise.all([
      getJSON('/api/capabilities?include=drafts'), getJSON('/api/runs'), getJSON('/api/interventions'), getJSON('/api/capabilities?format=openai')]);
    document.getElementById('dot').className = 'dot on';
    document.getElementById('liveText').textContent = 'live';
    const approved = caps.filter(c => c.approval.state === 'approved').length;
    document.getElementById('kCaps').textContent = caps.length;
    document.getElementById('kCapsHint').textContent = approved + ' approved for agents, ' + (caps.length - approved) + ' draft';
    document.getElementById('kWait').textContent = inbox.length;
    document.getElementById('kWaitTile').className = 'kpi' + (inbox.length ? ' alert' : '');
    let n = 0, ok = 0;
    caps.forEach(c => { if (c.reliability) { n += c.reliability.runs; ok += Math.round(c.reliability.successRate * c.reliability.runs); } });
    document.getElementById('kRuns').textContent = runs.live.length + runs.history.length;
    document.getElementById('kRunsHint').textContent = runs.live.length + ' this session';
    document.getElementById('kRate').textContent = n ? Math.round(100 * ok / n) + '%' : '\\u2013';
    document.getElementById('policyText').textContent = 'Approval: ' + policy.minRuns + '+ runs, ' + Math.round(policy.minConfidence*100) + '%+ confidence';
    renderInbox(inbox); renderCaps(caps); renderRuns(runs);
    document.getElementById('tools').textContent = JSON.stringify(tools, null, 2);
  } catch (e) {
    document.getElementById('dot').className = 'dot';
    document.getElementById('liveText').textContent = 'reconnecting\\u2026';
  }
}
getJSON('/api/policy').then(p => { policy = p; }).catch(() => {});
setInterval(() => { if (!document.activeElement || document.activeElement.tagName !== 'INPUT') refresh(); }, 2000);
refresh();
</script></body></html>`;
