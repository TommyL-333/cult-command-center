/**
 * TikTok API Map — Command Center page.
 * Portal-admin gated. Self-contained: mount(app) wires routes.
 * Renders the catalog in routes/tiktok-api-catalog.js with filters + scoreboard.
 *
 * Mount (in dashboard-server.js, BEFORE app.use(requireAuth)):
 *   const tiktokApiMap = require('./routes/tiktok-api-map');
 *   tiktokApiMap.mount(app);
 */
const { SURFACES, MODULES } = require('./tiktok-api-catalog');

function computeStats() {
  let direct = 0, third = 0, none = 0, total = 0;
  for (const m of MODULES) for (const e of m.endpoints) {
    total++;
    if (e.access === 'direct') direct++;
    else if (e.access === 'third-party') third++;
    else none++;
  }
  return { direct, third, none, total };
}

const ACCESS_META = {
  'direct':      { label: 'Direct',      color: '#00f2ea', dot: '🟢', desc: 'We call it ourselves via our own TikTok app.' },
  'third-party': { label: '3rd Party',   color: '#f5b700', dot: '🟡', desc: 'We access it today through Reacher (or another vendor).' },
  'none':        { label: 'No Access',   color: '#ff0050', dot: '🔴', desc: 'Not available to us yet — roadmap target.' },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pageHtml() {
  const stats = computeStats();
  const pct = (n) => stats.total ? Math.round((n / stats.total) * 100) : 0;
  const dataJson = JSON.stringify({ surfaces: SURFACES, modules: MODULES, stats, accessMeta: ACCESS_META });

  return [
'<!doctype html><html lang="en"><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>TikTok API Map — Cult Content</title>',
'<style>',
'*{box-sizing:border-box;margin:0;padding:0}',
"body{background:#161823;color:#e8e8ed;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5;padding:0 0 80px}",
'.wrap{max-width:1180px;margin:0 auto;padding:0 20px}',
'header.top{padding:28px 0 18px;border-bottom:1px solid #262838;margin-bottom:24px}',
'h1{font-size:1.7rem;font-weight:700;letter-spacing:-.5px;background:linear-gradient(90deg,#00f2ea,#ff0050);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}',
'.sub{color:#8b8d98;font-size:.92rem;margin-top:6px;max-width:760px}',
'.back{color:#00f2ea;text-decoration:none;font-size:.82rem;display:inline-block;margin-bottom:14px}',
'.score{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:22px 0}',
'.card{background:#1d1f2e;border:1px solid #2a2c3d;border-radius:14px;padding:18px}',
'.card .n{font-size:2rem;font-weight:700}.card .l{color:#8b8d98;font-size:.82rem;margin-top:2px}',
'.card .bar{height:6px;border-radius:4px;background:#2a2c3d;margin-top:12px;overflow:hidden}',
'.card .bar i{display:block;height:100%}',
'.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 24px}',
'.chip{background:#1d1f2e;border:1px solid #2a2c3d;color:#c9cad4;border-radius:999px;padding:7px 14px;font-size:.82rem;cursor:pointer;transition:.15s}',
'.chip:hover{border-color:#3a3c50}.chip.on{background:#00f2ea18;border-color:#00f2ea;color:#00f2ea}',
'.chip.on.tp{background:#f5b70018;border-color:#f5b700;color:#f5b700}',
'.chip.on.no{background:#ff005018;border-color:#ff0050;color:#ff0050}',
'.search{flex:1;min-width:180px;background:#1d1f2e;border:1px solid #2a2c3d;color:#e8e8ed;border-radius:10px;padding:9px 13px;font-size:.88rem}',
'.search:focus{outline:none;border-color:#00f2ea}',
'.mod{background:#1a1c29;border:1px solid #262838;border-radius:14px;margin-bottom:16px;overflow:hidden}',
'.mod-h{display:flex;align-items:center;gap:12px;padding:16px 18px;cursor:pointer}',
'.mod-h .ic{font-size:1.4rem}.mod-h .nm{font-weight:600;font-size:1.05rem}',
'.mod-h .surf{font-size:.68rem;text-transform:uppercase;letter-spacing:.5px;padding:3px 8px;border-radius:6px;background:#262838;color:#9a9cab}',
'.mod-h .surf.dev{background:#5b21b633;color:#c4b5fd}',
'.mod-h .sm{color:#8b8d98;font-size:.82rem;flex:1}',
'.mod-h .cnt{font-size:.74rem;color:#8b8d98;white-space:nowrap}',
'.mod-b{padding:0 18px 6px}',
'.ep{border-top:1px solid #23253420;padding:13px 0;display:grid;grid-template-columns:120px 1fr;gap:14px}',
'.ep:first-child{border-top:1px solid #232534}',
'.ep .badge{font-size:.7rem;font-weight:600;padding:4px 9px;border-radius:7px;display:inline-block;white-space:nowrap;align-self:start}',
'.ep .epn{font-weight:600;font-size:.92rem}',
'.ep .epp{font-family:ui-monospace,Menlo,monospace;font-size:.74rem;color:#7fd4cf;margin-top:3px;word-break:break-all}',
'.ep .epu{color:#9a9cab;font-size:.82rem;margin-top:6px}',
'.ep .vflag{font-size:.66rem;color:#f5b700;margin-top:4px}',
'.hidden{display:none}',
'.legend{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0 0;color:#8b8d98;font-size:.78rem}',
'.note{background:#1d1f2e;border:1px solid #2a2c3d;border-left:3px solid #f5b700;border-radius:10px;padding:12px 16px;font-size:.82rem;color:#b8bac6;margin-bottom:22px}',
'@media(max-width:640px){.ep{grid-template-columns:1fr}}',
'</style></head><body><div class="wrap">',
'<header class="top">',
'<a class="back" href="/portal-admin">← Command Center</a>',
'<h1>TikTok API Map</h1>',
'<div class="sub">Every TikTok API surface we touch — what we own directly, what we rent through Reacher, and what we don\'t have yet. This map drives the product roadmap toward full API ownership.</div>',
'<div class="legend">',
'<span>🟢 Direct (our app)</span><span>🟡 3rd party (Reacher)</span><span>🔴 No access yet</span><span style="color:#f5b700">⚠ path needs live verification</span>',
'</div>',
'</header>',
'<div class="score">',
'<div class="card"><div class="n" style="color:#00f2ea">'+stats.direct+'</div><div class="l">Direct access</div><div class="bar"><i style="width:'+pct(stats.direct)+'%;background:#00f2ea"></i></div></div>',
'<div class="card"><div class="n" style="color:#f5b700">'+stats.third+'</div><div class="l">Via 3rd party (Reacher)</div><div class="bar"><i style="width:'+pct(stats.third)+'%;background:#f5b700"></i></div></div>',
'<div class="card"><div class="n" style="color:#ff0050">'+stats.none+'</div><div class="l">No access yet</div><div class="bar"><i style="width:'+pct(stats.none)+'%;background:#ff0050"></i></div></div>',
'<div class="card"><div class="n">'+stats.total+'</div><div class="l">Endpoints mapped</div><div class="bar"><i style="width:100%;background:#3a3c50"></i></div></div>',
'</div>',
'<div class="note">⚠ Endpoints marked with a warning are catalogued from TikTok\'s published docs but their exact version/path should be re-confirmed against the live partner/developer portal before we build against them. Edit <code>routes/tiktok-api-catalog.js</code> to keep this map current as we bring endpoints in-house.</div>',
'<div class="controls">',
'<input class="search" id="q" placeholder="Search endpoints, modules, usage…">',
'<span class="chip on" data-acc="all" id="c-all">All</span>',
'<span class="chip on" data-acc="direct" id="c-direct">🟢 Direct</span>',
'<span class="chip on tp" data-acc="third-party" id="c-tp">🟡 3rd party</span>',
'<span class="chip on no" data-acc="none" id="c-no">🔴 None</span>',
'<span class="chip on" data-surf="SHOP" id="c-shop">Shop API</span>',
'<span class="chip on" data-surf="DEV" id="c-dev">Dev Platform</span>',
'</div>',
'<div id="list"></div>',
'</div>',
'<script>var DATA='+dataJson+';',
'var AM=DATA.accessMeta;',
'var state={acc:{ "direct":true,"third-party":true,"none":true },surf:{SHOP:true,DEV:true},q:""};',
'function epHtml(e){var m=AM[e.access];',
" return '<div class=\"ep\" data-acc=\"'+e.access+'\">'",
" +'<div><span class=\"badge\" style=\"background:'+m.color+'22;color:'+m.color+'\">'+m.dot+' '+m.label+'</span></div>'",
" +'<div><div class=\"epn\">'+esc(e.name)+'</div>'",
" +'<div class=\"epp\">'+esc(e.path)+'</div>'",
" +'<div class=\"epu\">'+esc(e.usage)+'</div>'",
" +(e.verified?'':'<div class=\"vflag\">⚠ path/version not yet verified against live portal</div>')",
" +'</div></div>';}",
'function esc(s){s=(s==null?"":""+s);return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}',
'function render(){var host=document.getElementById("list");var html="";var q=state.q.toLowerCase();',
' DATA.modules.forEach(function(mod){',
'  if(!state.surf[mod.surface])return;',
'  var eps=mod.endpoints.filter(function(e){',
'   if(!state.acc[e.access])return false;',
'   if(q){var blob=(mod.name+" "+mod.summary+" "+e.name+" "+e.path+" "+e.usage).toLowerCase();if(blob.indexOf(q)<0)return false;}',
'   return true;});',
'  if(!eps.length)return;',
'  var surfCls=mod.surface==="DEV"?"surf dev":"surf";',
'  var surfLbl=mod.surface==="DEV"?"Dev":"Shop";',
"  html+='<div class=\"mod\"><div class=\"mod-h\">'",
"   +'<span class=\"ic\">'+mod.icon+'</span>'",
"   +'<span class=\"nm\">'+esc(mod.name)+'</span>'",
"   +'<span class=\"'+surfCls+'\">'+surfLbl+'</span>'",
"   +'<span class=\"sm\">'+esc(mod.summary)+'</span>'",
"   +'<span class=\"cnt\">'+eps.length+' shown</span></div>'",
"   +'<div class=\"mod-b\">'+eps.map(epHtml).join('')+'</div></div>';",
' });',
' host.innerHTML=html||\'<div class="note" style="border-left-color:#00f2ea">No endpoints match the current filters.</div>\';}',
'function bindChip(id,fn){document.getElementById(id).addEventListener("click",function(){fn(this);render();});}',
'bindChip("c-direct",function(el){state.acc.direct=!state.acc.direct;el.classList.toggle("on",state.acc.direct);syncAll();});',
'bindChip("c-tp",function(el){state.acc["third-party"]=!state.acc["third-party"];el.classList.toggle("on",state.acc["third-party"]);syncAll();});',
'bindChip("c-no",function(el){state.acc.none=!state.acc.none;el.classList.toggle("on",state.acc.none);syncAll();});',
'bindChip("c-shop",function(el){state.surf.SHOP=!state.surf.SHOP;el.classList.toggle("on",state.surf.SHOP);});',
'bindChip("c-dev",function(el){state.surf.DEV=!state.surf.DEV;el.classList.toggle("on",state.surf.DEV);});',
'bindChip("c-all",function(el){var on=!(state.acc.direct&&state.acc["third-party"]&&state.acc.none);state.acc.direct=state.acc["third-party"]=state.acc.none=on;el.classList.toggle("on",on);document.getElementById("c-direct").classList.toggle("on",on);document.getElementById("c-tp").classList.toggle("on",on);document.getElementById("c-no").classList.toggle("on",on);});',
'function syncAll(){var all=state.acc.direct&&state.acc["third-party"]&&state.acc.none;document.getElementById("c-all").classList.toggle("on",all);}',
'document.getElementById("q").addEventListener("input",function(){state.q=this.value;render();});',
'render();',
'</script></body></html>'
  ].join('');
}

function mount(app, opts) {
  opts = opts || {};
  const guard = opts.requirePortalAdmin || ((req, res, next) => {
    if (req.session && req.session.isPortalAdmin) return next();
    return res.redirect('/portal-admin-login');
  });
  app.get('/tiktok-api-map', guard, (req, res) => {
    res.type('html').send(pageHtml());
  });
  // JSON for programmatic use / future editing UI
  app.get('/api/tiktok-api-map', guard, (req, res) => {
    res.json({ surfaces: SURFACES, modules: MODULES, stats: computeStats() });
  });
}

module.exports = { mount, pageHtml, computeStats };
