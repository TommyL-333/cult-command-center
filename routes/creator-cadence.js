// routes/creator-cadence.js
// Creator launch cadence engine + approval gate.
//
// Two cadences:
//  A) LAUNCH BLAST  -> ALL `affiliate` creators, anchored to creatorKickoffDate.
//     6 texts: T1 announce, T2 (3d before), T3 (morning of), T4 (1h before),
//     T5 (start of call), T6 (brand sign-up link push).
//  B) WEEKLY CALL   -> only `{brand}-affiliate` creators, recurring on the
//     brand's weeklyCallDay/weeklyCallTime.
//
// NOTHING SENDS AUTOMATICALLY. Every text is generated as a DRAFT and must be
// approved/sent by a human from the approval page (/creator-cadence) which is
// gated behind the portal-admin session.
//
// Mount (one line in dashboard-server.js, before app.listen, before requireAuth):
//   const creatorCadence = require('./routes/creator-cadence');
//   creatorCadence.mount(app, { DATA_DIR, loadPendingOnboards });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VER = '2021-07-28';
const LOC = () => process.env.GHL_LOCATION_ID || process.env.GHL_LOC_ID;
const ghlHeaders = () => ({
  Authorization: `Bearer ${process.env.GHL_API_KEY}`,
  Version: GHL_VER,
  'Content-Type': 'application/json',
});

// ─── Text templates (Tommy's voice) ─────────────────────────────────────────
// {brand} {firstName} {signupLink} {callDay} {callTime} {kickoffDate} are filled in.

const LAUNCH_TEMPLATES = {
  T1: {
    label: 'T1 · Announcement (on onboard)',
    body:
`New brand just joined the cult 👁️ — {brand}.

We're building a creator push around it and you're invited. First kickoff call is {kickoffDate}. More details coming — keep an eye on this thread.`,
  },
  T2: {
    label: 'T2 · 3 days before call',
    body:
`{firstName}, the {brand} kickoff call is in 3 days ({kickoffDate}).

This is where we break down the product, the content angles that are working, and how you get paid. Show up — first movers win the early collabs.`,
  },
  T3: {
    label: 'T3 · Morning of call',
    body:
`Today's the day 👁️ — {brand} kickoff call at {callTime} ET.

Bring your questions. We'll show you exactly what to film and how the commission works. See you there.`,
  },
  T4: {
    label: 'T4 · 1 hour before',
    body:
`Starting in 1 hour — {brand} kickoff call at {callTime} ET.

Last call to join live. This is the room where the winning creators get matched first.`,
  },
  T5: {
    label: 'T5 · Start of call',
    body:
`We're LIVE right now 👁️ — {brand} kickoff call. Jump in:

[CALL LINK]

Come say hi even if you're late — we'll catch you up.`,
  },
  T6: {
    label: 'T6 · Sign-up link push (after call)',
    body:
`Missed the {brand} call? No stress �����️

Here's your link to sign up as a {brand} creator and start earning:
{signupLink}

Sign up and you'll get the product, the content brief, and an invite to the weekly {brand} creator call.`,
  },
};

const WEEKLY_TEMPLATE = {
  label: 'Weekly · {brand} creator call reminder',
  body:
`{firstName}, the weekly {brand} creator call is today at {callTime} ET 👁️

Bring what you've posted, what's working, what's not. This is where we tune your content and push your numbers up. See you there.`,
};

// ─── Storage ─────────────────────────────────────────────────────────────────
function fileFor(dir) { return path.join(dir, 'creator-cadence-blasts.json'); }
function loadBlasts(dir) {
  try { return JSON.parse(fs.readFileSync(fileFor(dir), 'utf8')); } catch (_) { return []; }
}
function saveBlasts(dir, data) {
  fs.writeFileSync(fileFor(dir), JSON.stringify(data, null, 2));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function brandSlug(name) {
  return String(name || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function fmtDate(d) {
  if (!d) return 'TBD';
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); }
  catch (_) { return d; }
}
function fmtTime(t) {
  if (!t) return 'TBD';
  try {
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    const hh = ((h + 11) % 12) + 1;
    return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
  } catch (_) { return t; }
}
function fill(tpl, ctx) {
  return tpl
    .replace(/\{brand\}/g, ctx.brand || 'the brand')
    .replace(/\{firstName\}/g, ctx.firstName || 'there')
    .replace(/\{signupLink\}/g, ctx.signupLink || '')
    .replace(/\{callDay\}/g, ctx.callDay || 'TBD')
    .replace(/\{callTime\}/g, ctx.callTime || 'TBD')
    .replace(/\{kickoffDate\}/g, ctx.kickoffDate || 'TBD');
}

// Flatten the real pending-onboard shape: timing/brand fields live under formData.
// Falls back to top-level so the helpers stay unit-testable with flat objects.
function normalizeOnboard(ob) {
  const f = (ob && ob.formData) || {};
  return {
    brandName:         ob.brandName        || f.brandName        || ob.brand || ob.name,
    weeklyCallDay:     ob.weeklyCallDay     || f.weeklyCallDay,
    weeklyCallTime:    ob.weeklyCallTime    || f.weeklyCallTime,
    creatorKickoffDate:ob.creatorKickoffDate|| f.creatorKickoffDate,
    creatorPageUrl:    ob.creatorPageUrl    || (ob.creatorPage && ob.creatorPage.url) || f.creatorPageUrl,
    creatorSignupUrl:  ob.creatorSignupUrl  || f.creatorSignupUrl,
  };
}

// Build the 6 launch drafts for one onboarded brand
function buildLaunchBlasts(onboardRaw) {
  const onboard = normalizeOnboard(onboardRaw);
  const brand = onboard.brandName || onboard.brand || onboard.name || 'New Brand';
  const slug = brandSlug(brand);
  const signupLink = onboard.creatorPageUrl || onboard.creatorSignupUrl ||
    `https://portal.cultcontent.cc/creators?brand=${slug}`;
  const ctx = {
    brand,
    callDay: onboard.weeklyCallDay,
    callTime: fmtTime(onboard.weeklyCallTime),
    kickoffDate: fmtDate(onboard.creatorKickoffDate),
    signupLink,
  };
  const now = Date.now();
  return Object.entries(LAUNCH_TEMPLATES).map(([key, t]) => ({
    id: `${slug}-${key}-${now}`,
    cadence: 'launch',
    brand, brandSlug: slug,
    step: key,
    label: t.label,
    audienceTag: 'affiliate',
    body: fill(t.body, ctx),
    status: 'draft',          // draft -> approved -> sent
    createdAt: new Date().toISOString(),
    kickoffDate: onboard.creatorKickoffDate || null,
    sentAt: null, sentCount: 0,
  }));
}

// Build a weekly reminder draft for a brand (Cadence B)
function buildWeeklyBlast(onboardRaw) {
  const onboard = normalizeOnboard(onboardRaw);
  const brand = onboard.brandName || onboard.brand || onboard.name || 'New Brand';
  const slug = brandSlug(brand);
  const ctx = { brand, callDay: onboard.weeklyCallDay, callTime: fmtTime(onboard.weeklyCallTime) };
  return {
    id: `${slug}-weekly-${Date.now()}`,
    cadence: 'weekly',
    brand, brandSlug: slug,
    step: 'WEEKLY',
    label: fill(WEEKLY_TEMPLATE.label, ctx),
    audienceTag: `${slug}-affiliate`,
    body: fill(WEEKLY_TEMPLATE.body, ctx),
    status: 'draft',
    createdAt: new Date().toISOString(),
    callDay: onboard.weeklyCallDay || null,
    callTime: onboard.weeklyCallTime || null,
    sentAt: null, sentCount: 0,
  };
}

// ─── GHL: fetch contacts by tag, send SMS ────────────────────────────────────
async function contactsByTag(tag) {
  let all = [], page = 1;
  while (page <= 30) {
    let r;
    try {
      r = await axios.post(`${GHL_BASE}/contacts/search`, {
        locationId: LOC(), pageLimit: 100, page,
        filters: [{ field: 'tags', operator: 'contains', value: tag }],
      }, { headers: ghlHeaders() });
    } catch (_) { break; }
    const cs = r.data?.contacts || [];
    all.push(...cs);
    if (cs.length < 100) break;
    page++;
  }
  return all;
}

async function sendSms(contact, message) {
  const contactId = contact.id;
  let conversationId;
  try {
    const cr = await axios.post(`${GHL_BASE}/conversations/`, {
      locationId: LOC(), contactId,
    }, { headers: ghlHeaders() });
    conversationId = cr.data?.conversationId || cr.data?.id;
  } catch (ce) {
    conversationId = ce.response?.data?.conversationId;
    if (!conversationId) throw ce;
  }
  const firstName = contact.firstName || (contact.contactName || '').split(' ')[0] || 'there';
  await axios.post(`${GHL_BASE}/conversations/messages`, {
    type: 'SMS', conversationId, contactId,
    message: message.replace(/\{firstName\}/g, firstName),
  }, { headers: ghlHeaders() });
}

// Execute a blast: send SMS to every contact carrying its audienceTag
async function executeBlast(blast) {
  const contacts = await contactsByTag(blast.audienceTag);
  let ok = 0, fail = 0;
  for (const c of contacts) {
    try { await sendSms(c, blast.body); ok++; }
    catch (_) { fail++; }
  }
  return { audience: contacts.length, sent: ok, failed: fail };
}

// ─── EVENT-TRIGGER REFERENCE (read-only — hardcoded SMS that fire automatically) ──
// These document the SMS touchpoints wired elsewhere in dashboard-server.js so the
// console shows EVERY text a creator receives per brand, not just the editable blasts.
const EVENT_TRIGGERS = [
  {
    key: 'signup_welcome',
    label: 'Brand Signup Welcome SMS',
    trigger: 'Creator submits a brand interest / signup form',
    audience: 'The individual creator who just signed up — brand-specific',
    source: 'dashboard-server.js /api/creator-pages/submit',
    editable: false,
    brandScoped: true,
    note: 'Sent once, immediately on signup. Brand-aware: names the brand, states commission %, links to that brand page. Copy is hardcoded in the submit handler — edit there to change.',
    copy: "You're in for {brandName} 👁️‼️ Welcome, {firstName}!\\n\\nHere's how to start earning with {brandName}:\\n→ Your {brandName} page (product + content brief): {baseUrl}/creators/{brandSlug}\\n→ You'll earn {commission}% commission on every {brandName} sale you drive\\n\\nAnd your community:\\n→ Discord: {discordLink}\\n→ Skool: https://www.skool.com/cult-content\\n\\nText this number anytime if you need us.",
  },
  {
    key: 'full_onboard_welcome',
    label: 'Full Onboard Welcome SMS',
    trigger: 'Creator completes full onboarding',
    audience: 'The individual creator who just onboarded',
    source: 'dashboard-server.js ~/api/creators/full-onboard',
    editable: false,
    note: 'Sent once on full onboard completion. Hardcoded copy.',
    copy: "Welcome to the Cult Content creator community, {firstName}! You're in 👁️‼️\\n\\nHere's everything you need:\\n→ Discord: {discordLink}\\n→ Skool: https://www.skool.com/cult-content\\n→ Brand opportunities: {baseUrl}/creators\\n\\nText this number anytime if you need us.",
  },
];

// ─── HTML console page ───────────────────────────────────────────────────────
function pageHtml() {
  return [
'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>SMS Communication — Cult Content</title>',
'<style>',
'body{margin:0;background:#161823;color:#e8e8ef;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}',
'h1{font-size:22px;margin:0 0 4px}.sub{color:#8b8b9a;font-size:13px;margin-bottom:20px}',
'.topbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:18px}',
'select,input{background:#13141c;color:#e8e8ef;border:1px solid #2a2c3a;border-radius:8px;padding:9px 12px;font-size:13px;font-family:inherit}',
'.tabs{display:flex;gap:8px;margin-bottom:18px}.tab{padding:8px 16px;border-radius:8px;background:#20222e;cursor:pointer;font-size:13px}',
'.tab.on{background:linear-gradient(90deg,#00f2ea,#ff0050);color:#000;font-weight:600}',
'.card{background:#1c1e2a;border:1px solid #2a2c3a;border-radius:12px;padding:16px;margin-bottom:14px}',
'.card.event{border-style:dashed;opacity:.92}',
'.row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px}',
'.lbl{font-weight:600;font-size:14px}.badge{font-size:11px;padding:3px 8px;border-radius:6px;background:#2a2c3a;color:#8b8b9a}',
'.badge.draft{color:#ffd166}.badge.sent{color:#06d6a0}.badge.auto{color:#00f2ea}',
'textarea{width:100%;box-sizing:border-box;background:#13141c;color:#e8e8ef;border:1px solid #2a2c3a;border-radius:8px;padding:10px;font-size:13px;min-height:90px;font-family:inherit}',
'.meta{font-size:12px;color:#8b8b9a;margin:6px 0}',
'.btns{display:flex;gap:8px;margin-top:8px}',
'button{border:none;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;font-weight:600}',
'.save{background:#2a2c3a;color:#e8e8ef}.send{background:linear-gradient(90deg,#00f2ea,#ff0050);color:#000}',
'button:disabled{opacity:.4;cursor:default}',
'.section-h{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#8b8b9a;margin:24px 0 10px}',
'.empty{color:#8b8b9a;padding:30px;text-align:center}',
'.newbtn{background:#20222e;color:#00f2ea;border:1px solid #2a2c3a}',
'.overlay{position:fixed;inset:0;background:rgba(8,9,14,.72);backdrop-filter:blur(4px);display:none;align-items:flex-start;justify-content:center;padding:40px 16px;z-index:50;overflow:auto}',
'.overlay.on{display:flex}',
'.modal{background:#1c1e2a;border:1px solid #2a2c3a;border-radius:16px;width:100%;max-width:560px;padding:24px}',
'.modal h2{margin:0 0 4px;font-size:18px}.modal .mh-sub{color:#8b8b9a;font-size:12px;margin-bottom:18px}',
'.fld{margin-bottom:16px}.fld label{display:block;font-size:12px;color:#8b8b9a;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}',
'.fld select,.fld input,.fld textarea{width:100%;box-sizing:border-box}',
'.fld textarea{min-height:120px;resize:vertical;line-height:1.5}',
'.tokens{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}',
'.tok{background:#20222e;border:1px solid #2a2c3a;color:#00f2ea;font-size:11px;padding:4px 9px;border-radius:6px;cursor:pointer;font-weight:600}',
'.tok:hover{border-color:#00f2ea}',
'.counter{font-size:11px;color:#8b8b9a;margin-top:6px;text-align:right}.counter b{color:#e8e8ef}',
'.aud-hint{font-size:12px;color:#8b8b9a;margin-top:6px}.aud-hint b{color:#00f2ea}',
'.preview{background:#0f1620;border:1px solid #213040;border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.5;white-space:pre-wrap;color:#cfe9ff;margin-top:8px}',
'.preview-h{font-size:11px;color:#8b8b9a;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 0}',
'.modal-btns{display:flex;gap:10px;justify-content:flex-end;margin-top:22px}',
'.btn-cancel{background:#2a2c3a;color:#e8e8ef}.btn-create{background:linear-gradient(90deg,#00f2ea,#ff0050);color:#000}',
'</style></head><body>',
'<h1>SMS Communication 👁️</h1>',
'<div class="overlay" id="overlay">',
'<div class="modal">',
'<h2>New SMS</h2>',
'<div class="mh-sub">Compose a one-off text. It saves as a draft and never sends until you hit Send Now.</div>',
'<div class="fld"><label>Brand</label><select id="m_brand" onchange="updateAud();updateBody()"></select></div>',
'<div class="fld"><label>Audience type</label><select id="m_type" onchange="updateAud()"><option value="launch">Launch / announcement \\u2014 entire community</option><option value="weekly">Weekly / brand-only \\u2014 this brand affiliates</option></select><div class="aud-hint" id="m_aud"></div></div>',
'<div class="fld"><label>Label (internal name)</label><input id="m_label" placeholder="e.g. Friday flash drop"></div>',
'<div class="fld"><label>Message</label><textarea id="m_body" oninput="updateBody()" placeholder="Write your text\\u2026 use the tokens below to personalize."></textarea>',
'<div class="tokens"><span class="tok" onclick="insFirst()">+ first name</span><span class="tok" onclick="insBrand()">+ brand name</span></div>',
'<div class="counter" id="m_count"></div></div>',
'<div class="preview-h">Preview</div><div class="preview" id="m_preview"></div>',
'<div class="modal-btns"><button class="btn-cancel" onclick="closeModal()">Cancel</button><button class="btn-create" id="m_create" onclick="createCadence()">Create draft</button></div>',
'</div></div>',
'<div class="sub">Every SMS touchpoint per brand — signup triggers, launch blasts, weekly call reminders. Editable blasts never send until you click <b>Send Now</b>.</div>',
'<div class="topbar">',
'<label style="font-size:13px;color:#8b8b9a">Brand</label>',
'<select id="brandSel" onchange="render()"></select>',
'<button class="newbtn" onclick="newCadence()">+ New Cadence</button>',
'</div>',
'<div class="tabs">',
'<div class="tab on" data-c="all" onclick="sw(this)">All</div>',
'<div class="tab" data-c="launch" onclick="sw(this)">Launch Blasts</div>',
'<div class="tab" data-c="weekly" onclick="sw(this)">Weekly Calls</div>',
'<div class="tab" data-c="event" onclick="sw(this)">Auto Triggers</div>',
'</div>',
'<div id="list"></div>',
'<script>',
'var DATA=[],EVENTS=[],BRANDS=[],CUR="all",BRAND="";',
'function sw(el){document.querySelectorAll(".tab").forEach(t=>t.classList.remove("on"));el.classList.add("on");CUR=el.dataset.c;render();}',
'function esc(s){return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;");}',
'function brandsList(){var set={};BRANDS.forEach(b=>{if(b&&b.slug)set[b.slug]=b.name;});DATA.forEach(b=>{if(b.brand)set[b.brandSlug||b.brand]=b.brand;});return Object.keys(set).map(k=>({slug:k,name:set[k]})).sort((a,b)=>(a.name||"").localeCompare(b.name||""));}',
'function fillBrands(){var sel=document.getElementById("brandSel");var bs=brandsList();var opts=["<option value=\\"\\">All brands</option>"].concat(bs.map(b=>"<option value=\\""+esc(b.slug)+"\\">"+esc(b.name)+"</option>"));sel.innerHTML=opts.join("");sel.value=BRAND;}',
'function blastCard(b){return "<div class=\\"card\\"><div class=\\"row\\"><span class=\\"lbl\\">"+esc(b.brand)+" — "+esc(b.label)+"</span>"+"<span class=\\"badge "+b.status+"\\">"+b.status.toUpperCase()+"</span></div>"+"<div class=\\"meta\\">Audience: <b>"+esc(b.audienceTag)+"</b>"+(b.sentAt?(" · sent "+new Date(b.sentAt).toLocaleString()+" to "+b.sentCount):"")+"</div>"+"<textarea id=\\"t_"+b.id+"\\">"+esc(b.body)+"</textarea>"+"<div class=\\"btns\\"><button class=\\"save\\" onclick=\\"save(\'"+b.id+"\')\\">Save Edit</button>"+"<button class=\\"send\\" "+(b.status==="sent"?"disabled":"")+" onclick=\\"send(\'"+b.id+"\')\\">"+(b.status==="sent"?"Sent ✓":"Send Now")+"</button></div></div>";}',
'function eventCard(e){return "<div class=\\"card event\\"><div class=\\"row\\"><span class=\\"lbl\\">"+esc(e.label)+"</span><span class=\\"badge auto\\">AUTO</span></div>"+"<div class=\\"meta\\">Trigger: <b>"+esc(e.trigger)+"</b></div>"+"<div class=\\"meta\\">Audience: "+esc(e.audience)+"</div>"+"<div class=\\"meta\\">"+esc(e.note)+"</div>"+(e.copy?("<textarea readonly style=\\"opacity:.85\\">"+esc(e.copy)+"</textarea>"):"")+"<div class=\\"meta\\" style=\\"opacity:.6\\">Source: "+esc(e.source)+"</div></div>";}',
'function render(){var _sel=document.getElementById("brandSel");if(_sel)BRAND=_sel.value;fillBrands();var l=document.getElementById("list");var html="";',
'var blasts=DATA.filter(b=>!BRAND||(b.brandSlug||b.brand)===BRAND);',
'if(CUR==="event"){if(!EVENTS.length){l.innerHTML="<div class=\\"empty\\">No auto triggers defined.</div>";return;}l.innerHTML="<div class=\\"section-h\\">Automatic event-triggered SMS (read-only)</div>"+EVENTS.map(eventCard).join("");return;}',
'if(CUR==="launch")blasts=blasts.filter(b=>b.cadence==="launch");',
'else if(CUR==="weekly")blasts=blasts.filter(b=>b.cadence==="weekly");',
'if(CUR==="all"){var ln=blasts.filter(b=>b.cadence==="launch"),wk=blasts.filter(b=>b.cadence==="weekly");if(ln.length)html+="<div class=\\"section-h\\">Launch Blasts</div>"+ln.map(blastCard).join("");if(wk.length)html+="<div class=\\"section-h\\">Weekly Call Reminders</div>"+wk.map(blastCard).join("");html+="<div class=\\"section-h\\">Automatic Triggers</div>"+EVENTS.map(eventCard).join("");l.innerHTML=html||"<div class=\\"empty\\">No SMS for this brand yet. Use + New Cadence.</div>";return;}',
'if(!blasts.length){l.innerHTML="<div class=\\"empty\\">No "+CUR+" blasts"+(BRAND?" for this brand":"")+". They appear when a brand is onboarded, or use + New Cadence.</div>";return;}',
'l.innerHTML=blasts.map(blastCard).join("");}',
'function load(){fetch("/api/creator-cadence/blasts",{credentials:"include"}).then(r=>r.json()).then(d=>{DATA=d.blasts||[];EVENTS=d.events||[];BRANDS=d.brands||[];render();});}',
'function save(id){var body=document.getElementById("t_"+id).value;fetch("/api/creator-cadence/blasts/"+id,{method:"PATCH",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({body:body})}).then(()=>load());}',
'function send(id){var body=document.getElementById("t_"+id).value;if(!confirm("Send this text to everyone in the audience now?"))return;fetch("/api/creator-cadence/blasts/"+id+"/send",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({body:body})}).then(r=>r.json()).then(function(res){if(res.error){alert("Error: "+res.error);}else{alert("Sent to "+res.sent+" of "+res.audience+" creators.");}load();});}',
'function newCadence(){fillModalBrands();document.getElementById("m_type").value="launch";document.getElementById("m_label").value="";document.getElementById("m_body").value="";updateAud();updateBody();document.getElementById("overlay").classList.add("on");setTimeout(function(){document.getElementById("m_body").focus();},50);}',
'function closeModal(){document.getElementById("overlay").classList.remove("on");}',
'function fillModalBrands(){var sel=document.getElementById("m_brand");var bs=brandsList();sel.innerHTML=bs.map(function(b){return "<option value=\\""+esc(b.name)+"\\">"+esc(b.name)+"</option>";}).join("");if(BRAND){var match=bs.filter(function(b){return b.slug===BRAND;})[0];if(match)sel.value=match.name;}}',
'function updateAud(){var t=document.getElementById("m_type").value;var brand=document.getElementById("m_brand").value||"the brand";var hint=document.getElementById("m_aud");if(t==="weekly"){hint.innerHTML="Goes to <b>"+esc(brand)+" affiliates only</b> (creators who signed up for this brand).";}else{hint.innerHTML="Goes to the <b>entire creator community</b> (all affiliates).";}}',
'function insFirst(){insertTok(String.fromCharCode(123)+"firstName"+String.fromCharCode(125));}',
'function insBrand(){insertTok(String.fromCharCode(123)+"brandName"+String.fromCharCode(125));}',
'function insertTok(tok){var ta=document.getElementById("m_body");var a=ta.selectionStart;var b=ta.selectionEnd;if(a==null){a=ta.value.length;b=a;}ta.value=ta.value.slice(0,a)+tok+ta.value.slice(b);ta.focus();ta.selectionStart=ta.selectionEnd=a+tok.length;updateBody();}',
'function updateBody(){var v=document.getElementById("m_body").value;var brand=document.getElementById("m_brand").value||"Brand";var n=v.length;var per=n>160?153:160;var segs=n===0?0:Math.ceil(n/per);document.getElementById("m_count").innerHTML="<b>"+n+"</b> chars \\u00b7 <b>"+segs+"</b> SMS segment"+(segs===1?"":"s");var prev=v.replace(/\\{firstName\\}/g,"Jordan").replace(/\\{brandName\\}/g,brand)||"Your message preview appears here\\u2026";document.getElementById("m_preview").textContent=prev;}',
'function createCadence(){var brand=document.getElementById("m_brand").value;var cadence=document.getElementById("m_type").value;var label=document.getElementById("m_label").value||"Custom SMS";var body=document.getElementById("m_body").value;if(!brand){alert("Pick a brand.");return;}if(!body.trim()){alert("Write a message.");return;}var btn=document.getElementById("m_create");btn.disabled=true;fetch("/api/creator-cadence/manual",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({brand:brand,cadence:cadence,label:label,body:body})}).then(function(r){return r.json();}).then(function(res){btn.disabled=false;if(res.error){alert("Error: "+res.error);return;}closeModal();load();}).catch(function(){btn.disabled=false;alert("Network error");});}',
'load();',
'</script></body></html>',
  ].join('\n');
}

// ─── Mount ───────────────────────────────────────────────────────────────────
function mount(app, opts = {}) {
  const DATA_DIR = opts.DATA_DIR || process.env.DATA_DIR || '/data';
  const loadPendingOnboards = opts.loadPendingOnboards || (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'onboard-pending.json'), 'utf8')); }
    catch (_) { return []; }
  });

  // Admin gate — reuse portal-admin session
  function requireAdmin(req, res, next) {
    if (req.session && req.session.isPortalAdmin) return next();
    if (req.get('x-ic-admin-key') && req.get('x-ic-admin-key') === process.env.IC_ADMIN_KEY) return next();
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Generate launch blasts for any onboard that doesn't have them yet.
  // Call this on demand from the page load so newly-onboarded brands appear.
  function syncBlasts() {
    const pending = loadPendingOnboards();
    const blasts = loadBlasts(DATA_DIR);
    const existingBrands = new Set(blasts.filter(b => b.cadence === 'launch').map(b => b.brandSlug));
    const weeklyBrands = new Set(blasts.filter(b => b.cadence === 'weekly').map(b => b.brandSlug));
    let added = false;
    for (const ob of pending) {
      const brand = ob.brandName || ob.brand || ob.name;
      if (!brand) continue;
      const slug = brandSlug(brand);
      if (!existingBrands.has(slug)) {
        blasts.push(...buildLaunchBlasts(ob));
        existingBrands.add(slug); added = true;
      }
      if (!weeklyBrands.has(slug) && (ob.weeklyCallDay || ob.weeklyCallTime)) {
        blasts.push(buildWeeklyBlast(ob));
        weeklyBrands.add(slug); added = true;
      }
    }
    if (added) saveBlasts(DATA_DIR, blasts);
    return blasts;
  }

  // Approval page
  app.get('/sms-communication', requireAdmin, (req, res) => {
    res.set('Content-Type', 'text/html').send(pageHtml());
  });

  // Manual cadence creation — spin up an SMS for a brand with no onboard record.
  app.post('/api/creator-cadence/manual', requireAdmin, require('express').json({ limit: '256kb' }), (req, res) => {
    const { brand, cadence, label, body } = req.body || {};
    if (!brand || !body) return res.status(400).json({ error: 'brand and body required' });
    const type = cadence === 'weekly' ? 'weekly' : 'launch';
    const slug = brandSlug(brand);
    // Audience: weekly -> {brand}-affiliate ; launch -> affiliate (whole community)
    const audienceTag = type === 'weekly' ? slug + '-affiliate' : 'affiliate';
    const blasts = loadBlasts(DATA_DIR);
    const blast = {
      id: 'manual_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      cadence: type,
      brand,
      brandSlug: slug,
      label: label || 'Custom SMS',
      body,
      audienceTag,
      status: 'draft',
      manual: true,
      createdAt: new Date().toISOString(),
    };
    blasts.push(blast);
    saveBlasts(DATA_DIR, blasts);
    res.json({ ok: true, blast });
  });

  app.get('/creator-cadence', requireAdmin, (req, res) => {
    res.set('Content-Type', 'text/html').send(pageHtml());
  });

  // List blasts (sync first so new brands show up)
  // Build the full brand list for the dropdown: client brands from brands.json
  // (clients[].name) MERGED with any brands that already have blasts. This makes
  // every onboarded client selectable even before a launch blast is generated.
  function loadBrandList() {
    const set = {};
    try {
      const bj = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'brands.json'), 'utf8'));
      const clients = Array.isArray(bj) ? bj : (bj.clients || []);
      clients.forEach(b => { const n = b && (b.name || b.brandName); if (n) set[brandSlug(n)] = n; });
    } catch (_) {}
    try { loadBlasts(DATA_DIR).forEach(b => { if (b.brand) set[b.brandSlug || brandSlug(b.brand)] = b.brand; }); } catch (_) {}
    return Object.keys(set).map(k => ({ slug: k, name: set[k] })).sort((a,b)=>a.name.localeCompare(b.name));
  }

  app.get('/api/creator-cadence/blasts', requireAdmin, (req, res) => {
    try { res.json({ blasts: syncBlasts(), events: EVENT_TRIGGERS, brands: loadBrandList() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Edit a blast body
  app.use('/api/creator-cadence', require('express').json({ limit: '256kb' }));
  app.patch('/api/creator-cadence/blasts/:id', requireAdmin, (req, res) => {
    const blasts = loadBlasts(DATA_DIR);
    const b = blasts.find(x => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: 'not found' });
    if (typeof req.body.body === 'string') b.body = req.body.body;
    saveBlasts(DATA_DIR, blasts);
    res.json({ ok: true, blast: b });
  });

  // Send a blast NOW (human-approved)
  app.post('/api/creator-cadence/blasts/:id/send', requireAdmin, async (req, res) => {
    const blasts = loadBlasts(DATA_DIR);
    const b = blasts.find(x => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: 'not found' });
    if (b.status === 'sent') return res.status(400).json({ error: 'already sent' });
    if (typeof req.body.body === 'string') b.body = req.body.body;
    if (!process.env.GHL_API_KEY || !LOC()) return res.status(500).json({ error: 'GHL not configured' });
    try {
      const r = await executeBlast(b);
      b.status = 'sent'; b.sentAt = new Date().toISOString(); b.sentCount = r.sent;
      saveBlasts(DATA_DIR, blasts);
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  console.log('[creator-cadence] mounted at /creator-cadence');
}

module.exports = { mount, buildLaunchBlasts, buildWeeklyBlast, brandSlug };
