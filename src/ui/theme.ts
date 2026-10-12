export const THEME_CSS = `
:root{
  --bg:#f5f6f8; --card:#ffffff; --border:#e2e5ea; --border-strong:#cfd4db; --text:#15181d; --muted:#667080;
  --accent:#2457d6; --accent-soft:#e8eefc; --accent-ink:#ffffff;
  --ok:#137a43; --ok-soft:#e3f4ea; --warn:#9a6400; --warn-soft:#fdf2dc; --bad:#b3261e; --bad-soft:#fbe7e5;
  --info:#1f5fae; --info-soft:#e4effb; --idle:#6b7280; --idle-soft:#eef0f3;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --radius:10px; --shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.07);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0e1013; --card:#171a1f; --border:#262a31; --border-strong:#353a43; --text:#e8eaed; --muted:#98a1ad;
    --accent:#6f9bff; --accent-soft:#1c2740; --accent-ink:#0e1013;
    --ok:#4cc38a; --ok-soft:#14291f; --warn:#e5b04a; --warn-soft:#2d2412; --bad:#f2786e; --bad-soft:#331a18;
    --info:#7ab3f5; --info-soft:#152438; --idle:#98a1ad; --idle-soft:#1f2329;
  }
}
*{box-sizing:border-box}
html,body{margin:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.45}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1120px;margin:0 auto;padding:24px 20px 64px}
.topbar{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px}
.logo{width:28px;height:28px;border-radius:8px;background:var(--accent);display:grid;place-items:center;color:var(--accent-ink);font-weight:800;font-size:14px}
.brand h1{font-size:16px;font-weight:700;margin:0;letter-spacing:-.01em}
.brand .sub{font-size:12px;color:var(--muted)}
.spacer{flex:1}
.live{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--idle)}
.dot.on{background:var(--ok);box-shadow:0 0 0 3px var(--ok-soft)}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
.card + .card{margin-top:16px}
.card-h{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)}
.card-h h2{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0}
.card-h .count{font-size:11px;font-weight:700;color:var(--muted);background:var(--idle-soft);border-radius:999px;padding:1px 8px}
.card-b{padding:14px 16px}
.empty{padding:22px 16px;color:var(--muted);font-size:13px;text-align:center}
table{width:100%;border-collapse:collapse}
th{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);text-align:left;padding:9px 16px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:11px 16px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr.clickable{cursor:pointer}
tr.clickable:hover td{background:var(--bg)}
.mono{font-family:var(--mono);font-size:12.5px}
.muted{color:var(--muted)}
.small{font-size:12px}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;letter-spacing:.02em;padding:3px 8px;border-radius:999px;white-space:nowrap;background:var(--idle-soft);color:var(--idle)}
.badge.ok{background:var(--ok-soft);color:var(--ok)}
.badge.warn{background:var(--warn-soft);color:var(--warn)}
.badge.bad{background:var(--bad-soft);color:var(--bad)}
.badge.info{background:var(--info-soft);color:var(--info)}
.badge.accent{background:var(--accent-soft);color:var(--accent)}
.badge.pulse::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 1.4s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
button,.btn{font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;border-radius:8px;border:1px solid var(--border-strong);background:var(--card);color:var(--text);padding:6px 12px;display:inline-flex;align-items:center;gap:6px}
button:hover,.btn:hover{border-color:var(--accent);text-decoration:none}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button.primary:hover,.btn.primary:hover{filter:brightness(1.07)}
button:disabled{opacity:.5;cursor:not-allowed}
input[type=text],input[type=password],select{font:inherit;font-size:13px;border:1px solid var(--border-strong);border-radius:8px;padding:7px 9px;background:var(--card);color:var(--text);min-width:0}
input[type=text]:focus,input[type=password]:focus,select:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
label.field{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--muted)}
.meter{position:relative;width:96px;height:6px;border-radius:999px;background:var(--idle-soft);overflow:hidden;display:inline-block;vertical-align:middle}
.meter > span{position:absolute;inset:0 auto 0 0;border-radius:999px;background:var(--idle)}
.meter.ok > span{background:var(--ok)} .meter.warn > span{background:var(--warn)} .meter.bad > span{background:var(--bad)}
pre.code{font-family:var(--mono);font-size:12px;line-height:1.55;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:0;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}
`;

export const CLIENT_HELPERS = `
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function ago(iso){if(!iso)return'';const s=Math.max(0,Math.round((Date.now()-Date.parse(iso))/1000));if(s<60)return s+'s ago';const m=Math.round(s/60);if(m<60)return m+'m ago';const h=Math.round(m/60);return h<24?h+'h ago':Math.round(h/24)+'d ago'}
function ms(v){if(v==null)return'\\u2014';return v<1000?v+' ms':(v/1000).toFixed(1)+' s'}
const STATE_BADGE={INITIALIZED:'',RUNNING:'accent pulse',AWAITING_HUMAN:'warn pulse',COMPLETED:'ok',BUSINESS_OUTCOME:'info',FAILED:'bad'};
const STATE_LABEL={INITIALIZED:'Initialized',RUNNING:'Running',AWAITING_HUMAN:'Awaiting human',COMPLETED:'Completed',BUSINESS_OUTCOME:'Business outcome',FAILED:'Failed'};
function stateBadge(s){return '<span class="badge '+(STATE_BADGE[s]||'')+'">'+esc(STATE_LABEL[s]||s)+'</span>'}
`;
