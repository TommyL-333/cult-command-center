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
`Missed the {brand} call? No stress ������️

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
  logSentSms({ trigger: contact.__smsTrigger || 'blast', brand: contact.__smsBrand || null, name: contact.contactName || firstName, contactId, body: message.replace(/\{firstName\}/g, firstName) });
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

// ─── Delayed community-welcome SMS (fires ~90 min after brand signup) ─────────
// Community-wide intro: Discord, Skool, Friday community call. Sent once per
// contact, on a timer, so the brand-specific welcome lands first and this is a
// natural second touch into the broader Cult Content community.
const COMMUNITY_WELCOME_BODY =
  "Now that you're in, here's the wider Cult Content world 👁️\n\n" +
  "→ Discord (creators hang + brand drops): https://discord.gg/cultcontent\n" +
  "→ Skool (training + community): https://www.skool.com/cult-content\n" +
  "→ Community call every Friday 3pm ET: https://vc-usttp.larksuite.com/j/397129210\n\n" +
  "Browse every brand you can earn with: https://portal.cultcontent.cc/creators\n\n" +
  "Reply here anytime — we're real people.";

function schedFileFor(dir) { return path.join(dir, 'scheduled-sms.json'); }

// ─── Sent-SMS audit log (every outbound text, regardless of source) ──────────
function sentFileFor(dir) { return path.join(dir, 'sms-sent.json'); }
function loadSentLog(dir) {
  try { return JSON.parse(fs.readFileSync(sentFileFor(dir), 'utf8')); } catch (_) { return []; }
}
// Public: append one sent record. Fire-and-forget, never throws.
// rec = { trigger, brand, name, email, phone, contactId, body }
function logSentSms(rec = {}) {
  try {
    const dir = rec.dir || process.env.DATA_DIR || '/data';
    const log = loadSentLog(dir);
    log.unshift({
      id: 'snt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      ts: new Date().toISOString(),
      trigger: rec.trigger || 'unknown',
      brand: rec.brand || null,
      name: rec.name || null,
      email: rec.email || null,
      phone: rec.phone || null,
      contactId: rec.contactId || null,
      body: (rec.body || '').slice(0, 1200),
    });
    // keep most recent 500
    fs.writeFileSync(sentFileFor(dir), JSON.stringify(log.slice(0, 500), null, 2));
  } catch (_) {}
}
function loadScheduled(dir) {
  try { return JSON.parse(fs.readFileSync(schedFileFor(dir), 'utf8')); } catch (_) { return []; }
}
function saveScheduled(dir, data) {
  try { fs.writeFileSync(schedFileFor(dir), JSON.stringify(data, null, 2)); } catch (_) {}
}

// Public: enqueue a one-off delayed SMS to a single GHL contact.
// opts = { contactId, firstName, body, delayMs, kind, dir }
function enqueueScheduledSms(opts = {}) {
  const dir = opts.dir || process.env.DATA_DIR || '/data';
  if (!opts.contactId || !opts.body) return;
  const q = loadScheduled(dir);
  q.push({
    id: 'sch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    contactId: opts.contactId,
    firstName: opts.firstName || 'there',
    body: opts.body,
    kind: opts.kind || 'scheduled',
    brand: opts.brand || null,
    dueAt: Date.now() + (opts.delayMs || 0),
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  saveScheduled(dir, q);
}

// Drain due scheduled SMS. Called on an interval from mount().
async function drainScheduled(dir) {
  const q = loadScheduled(dir);
  const now = Date.now();
  let changed = false;
  for (const item of q) {
    if (item.status !== 'pending' || item.dueAt > now) continue;
    try {
      await sendSms({ id: item.contactId, firstName: item.firstName, __smsTrigger: item.kind || 'scheduled', __smsBrand: item.brand || null, contactName: item.firstName }, item.body);
      item.status = 'sent'; item.sentAt = new Date().toISOString();
    } catch (e) {
      item.attempts = (item.attempts || 0) + 1;
      item.lastError = e.response?.data?.message || e.message;
      if (item.attempts >= 5) item.status = 'failed';
    }
    changed = true;
  }
  // prune sent/failed older than 7 days to keep the file small
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const pruned = q.filter(i => i.status === 'pending' || new Date(i.sentAt || i.createdAt).getTime() > cutoff);
  if (changed || pruned.length !== q.length) saveScheduled(dir, pruned);
}

// ─── EVENT-TRIGGER REFERENCE (read-only — hardcoded SMS that fire automatically) ──
// These document the SMS touchpoints wired elsewhere in dashboard-server.js so the
// console shows EVERY text a creator receives per brand, not just the editable blasts.
const EVENT_TRIGGERS = [
  {
    key: 'community_welcome',
    label: 'Community Welcome SMS (delayed ~90 min)',
    trigger: 'Auto-fires ~90 minutes after a creator signs up for any brand',
    audience: 'The individual creator who just signed up — community-wide intro',
    source: 'routes/creator-cadence.js scheduled queue (enqueueScheduledSms)',
    editable: false,
    note: 'Second touch. Enqueued via enqueueScheduledSms() from both signup paths and sent ~90 min later by the drain loop. Copy = COMMUNITY_WELCOME_BODY.',
    copy: COMMUNITY_WELCOME_BODY,
  },
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
'<title>SMS Communication \u2014 Cult Content</title>',
'<style>',
'body{margin:0;background:#161823;color:#e8e8ef;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}',
'h1{font-size:22px;margin:0 0 4px}.sub{color:#8b8b9a;font-size:13px;margin-bottom:20px;max-width:680px;line-height:1.5}',
'.topbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:18px}',
'select{background:#13141c;color:#e8e8ef;border:1px solid #2a2c3a;border-radius:8px;padding:9px 12px;font-size:13px;font-family:inherit}',
'.tabs{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}.tab{padding:8px 16px;border-radius:8px;background:#20222e;cursor:pointer;font-size:13px}',
'.tab.on{background:linear-gradient(90deg,#00f2ea,#ff0050);color:#000;font-weight:600}',
'.card{background:#1c1e2a;border:1px solid #2a2c3a;border-radius:12px;padding:16px;margin-bottom:14px}',
'.card.event{border-style:dashed;opacity:.95}',
'.row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px}',
'.lbl{font-weight:600;font-size:14px}.meta{font-size:12px;color:#8b8b9a;margin-bottom:10px}',
'.badge{font-size:11px;padding:3px 8px;border-radius:6px;background:#2a2c3a;color:#8b8b9a}',
'.badge.draft{color:#ffd166}.badge.sent{color:#06d6a0}.badge.auto{color:#00f2ea}.badge.scheduled{color:#a78bfa}',
'.body{width:100%;box-sizing:border-box;background:#13141c;color:#cfd0db;border:1px solid #23252f;border-radius:8px;padding:11px;font-size:13px;line-height:1.5;font-family:inherit;white-space:pre-wrap;min-height:64px}',
'.btns{display:flex;gap:8px;margin-top:10px}',
'.btn{padding:8px 16px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600}',
'.btn-approve{background:linear-gradient(90deg,#00f2ea,#06d6a0);color:#000}',
'.section-h{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6b6b7a;margin:22px 0 10px}',
'.empty{color:#6b6b7a;font-size:13px;padding:18px;border:1px dashed #2a2c3a;border-radius:10px;text-align:center}',
'.ro-note{font-size:11px;color:#6b6b7a;margin-top:8px}',
'</style></head><body>',
'<h1>SMS Communication</h1>',
'<div class="sub">Read-only review &amp; approval. Every text below is shown exactly as it will send. Scheduled and weekly messages, plus automatic triggers, all surface here. Nothing goes out until you press <b>Approve &amp; Send</b>. Automatic triggers are reference-only.</div>',
'<div class="topbar"><label style="font-size:13px;color:#8b8b9a">Brand</label><select id="brand" onchange="setBrand(this.value)"><option value="">All brands</option></select></div>',
'<div class="tabs"><div class="tab on" data-c="all" onclick="setTab(this)">All</div><div class="tab" data-c="scheduled" onclick="setTab(this)">Scheduled</div><div class="tab" data-c="weekly" onclick="setTab(this)">Weekly</div><div class="tab" data-c="triggered" onclick="setTab(this)">Triggered</div><div class="tab" data-c="sent" onclick="setTab(this)">Sent</div></div>',
'<div id="list"></div>',
'<script>',
'var DATA=[],EVENTS=[],BRANDS=[],SENT=[],SENT_LOADED=false,CUR="all",BRAND="";',
'function esc(s){return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}',
'function badge(b){if(b.status==="sent")return "<span class=\\"badge sent\\">Sent</span>";if(b.cadence==="followup")return "<span class=\\"badge scheduled\\">Follow-up</span>";if(b.cadence==="weekly")return "<span class=\\"badge scheduled\\">Weekly</span>";if(b.cadence==="launch")return "<span class=\\"badge scheduled\\">Scheduled</span>";return "<span class=\\"badge draft\\">Draft</span>";}',
'function blastCard(b){',
'  if(b.cadence==="followup"){',
'    var sent=b.status==="sent";',
'    var recs=b.recipients||[];var skipped=b.skipped||[];',
'    var h="<div class=\\"card\\"><div class=\\"row\\"><span class=\\"lbl\\">"+esc(b.label||"Non-poster follow-up")+"</span>"+badge(b)+"</div>";',
'    h+="<div class=\\"meta\\">"+(b.brand?esc(b.brand)+" \\u00b7 ":"")+recs.length+" creator"+(recs.length===1?"":"s")+" to text"+(skipped.length?" \\u00b7 "+skipped.length+" skipped (no phone)":"")+"</div>";',
'    if(recs.length){h+="<details style=\\"margin:6px 0 10px\\"><summary style=\\"cursor:pointer;font-size:12px;color:#8b8b9a\\">Recipients ("+recs.length+")</summary><div style=\\"font-size:12px;color:#aaa;margin-top:4px\\">"+(recs.map(function(r){return "@"+esc(r.handle||r.name||"");}).join(", "))+"</div></details>";}',
'    if(skipped.length){h+="<details style=\\"margin:0 0 10px\\"><summary style=\\"cursor:pointer;font-size:12px;color:#8b8b9a\\">Skipped — no phone ("+skipped.length+")</summary><div style=\\"font-size:12px;color:#aaa;margin-top:4px\\">"+(skipped.map(function(r){return "@"+esc(r.handle||r.name||"");}).join(", "))+"</div></details>";}',
'    h+="<textarea class=\\"body\\" id=\\"t_"+b.id+"\\""+(sent?" readonly":"")+">"+esc(b.body)+"</textarea>";',
'    if(!sent){h+="<div class=\\"btns\\"><button class=\\"btn btn-approve\\" onclick=\\"approveFollowup(\\u0027"+b.id+"\\u0027)\\">Approve &amp; Send</button><button class=\\"btn btn-delete\\" onclick=\\"del(\\u0027"+b.id+"\\u0027)\\">Delete</button></div>";h+="<div class=\\"ro-note\\">Each creator gets their own message with {firstName} substituted. Only recipients with phone numbers will be texted.</div>";}',
'    h+="</div>";return h;',
'  }',
'  var sent=b.status==="sent";',
'  var aud=b.audienceTag==="affiliate"?"Entire creator community":(b.brand?b.brand+" affiliates":"Brand affiliates");',
'  var h="<div class=\\"card\\"><div class=\\"row\\"><span class=\\"lbl\\">"+esc(b.label||"SMS")+"</span>"+badge(b)+"</div>";',
'  h+="<div class=\\"meta\\">"+(b.brand?esc(b.brand)+" \\u00b7 ":"")+esc(aud)+"</div>";',
'  h+="<textarea class=\\"body\\" id=\\"t_"+b.id+"\\""+(sent?" readonly":"")+">"+esc(b.body)+"</textarea>";',
'  if(!sent){h+="<div class=\\"btns\\"><button class=\\"btn btn-approve\\" onclick=\\"approve(\\u0027"+b.id+"\\u0027)\\">Approve &amp; Send</button><button class=\\"btn btn-delete\\" onclick=\\"del(\\u0027"+b.id+"\\u0027)\\">Delete</button></div>";h+="<div class=\\"ro-note\\">Edit the copy above if needed, then approve. This sends to everyone in the audience.</div>";}',
'  h+="</div>";return h;',
'}',
'function eventCard(e){',
'  var h="<div class=\\"card event\\"><div class=\\"row\\"><span class=\\"lbl\\">"+esc(e.label)+"</span><span class=\\"badge auto\\">Automatic</span></div>";',
'  h+="<div class=\\"meta\\">"+esc(e.trigger||"")+(e.audience?" \\u00b7 "+esc(e.audience):"")+"</div>";',
'  if(e.copy){h+="<textarea class=\\"body\\" readonly>"+esc(e.copy)+"</textarea>";}',
'  if(e.note){h+="<div class=\\"ro-note\\">"+esc(e.note)+"</div>";}',
'  h+="</div>";return h;',
'}',
'function esc(t){return String(t||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}',
'function sentCard(r){',
'  var when=new Date(r.ts).toLocaleString();',
'  var who=esc(r.name||r.email||r.contactId||"creator");',
'  var brand=r.brand?(" \u00b7 "+esc(r.brand)):"";',
'  return "<div class=\u0027card\u0027><div class=\u0027row\u0027><span class=\u0027lbl\u0027>"+esc(r.trigger)+"</span><span class=\u0027badge sent\u0027>sent</span></div>"+',
'    "<div class=\u0027meta\u0027>"+who+brand+" \u00b7 "+when+"</div>"+',
'    "<div style=\u0027white-space:pre-wrap;font-size:13px;color:#c8c8d4;line-height:1.5\u0027>"+esc(r.body)+"</div></div>";',
'}',
'function render(){',
'  var l=document.getElementById("list");',
'  var blasts=DATA.filter(function(b){return !BRAND||b.brandSlug===BRAND;});',
'  var sched=blasts.filter(function(b){return b.cadence===\"launch\"||b.cadence===\"manual\";});',
'  var wk=blasts.filter(function(b){return b.cadence==="weekly";});',
'  var fu=blasts.filter(function(b){return b.cadence==="followup";});',
'  var trig=EVENTS;',
'  var html="";',
'  if(CUR==="all"){',
'    if(fu.length)html+="<div class=\\"section-h\\">Non-poster follow-ups</div>"+fu.map(blastCard).join("");',
'    if(sched.length)html+="<div class=\\"section-h\\">Scheduled messages</div>"+sched.map(blastCard).join("");',
'    if(wk.length)html+="<div class=\\"section-h\\">Weekly messages</div>"+wk.map(blastCard).join("");',
'    html+="<div class=\\"section-h\\">Automatic triggers</div>"+trig.map(eventCard).join("");',
'    l.innerHTML=html||"<div class=\\"empty\\">Nothing to review yet.</div>";return;',
'  }',
'  if(CUR==="scheduled"){l.innerHTML=sched.length?sched.map(blastCard).join(""):"<div class=\\"empty\\">No scheduled messages"+(BRAND?" for this brand":"")+".</div>";return;}',
'  if(CUR==="weekly"){l.innerHTML=wk.length?wk.map(blastCard).join(""):"<div class=\\"empty\\">No weekly messages"+(BRAND?" for this brand":"")+".</div>";return;}',
'  if(CUR==="triggered"){l.innerHTML=trig.length?trig.map(eventCard).join(""):"<div class=\\"empty\\">No automatic triggers.</div>";return;}',
'  if(CUR==="sent"){',
'    if(!SENT_LOADED){l.innerHTML="<div class=\u0027empty\u0027>Loading\u2026</div>";loadSent();return;}',
'    var rows=BRAND?SENT.filter(function(r){return (r.brand||"").toLowerCase().indexOf(BRAND.toLowerCase())>=0;}):SENT;',
'    l.innerHTML=rows.length?rows.map(sentCard).join(""):"<div class=\u0027empty\u0027>No texts sent yet"+(BRAND?" for this brand":"")+".</div>";return;',
'  }',
'}',
'function setTab(el){CUR=el.getAttribute("data-c");var ts=document.querySelectorAll(".tab");for(var i=0;i<ts.length;i++)ts[i].classList.remove("on");el.classList.add("on");render();}',
'function setBrand(v){BRAND=v;render();}',
'function fillBrands(){var sel=document.getElementById("brand");BRANDS.forEach(function(b){var o=document.createElement("option");o.value=b.slug;o.textContent=b.name;sel.appendChild(o);});}',
'function approve(id){var body=document.getElementById("t_"+id).value;if(!confirm("Approve and send this text to everyone in the audience now?"))return;fetch("/api/sms-communication/blasts/"+id+"/send",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({body:body})}).then(function(r){return r.json();}).then(function(res){if(res.error){alert("Error: "+res.error);}else{alert("Sent to "+res.sent+" of "+res.audience+" creators.");}load();});}',
'function approveFollowup(id){var body=document.getElementById("t_"+id).value;var b=DATA.find(function(x){return x.id===id;});var n=b&&b.recipients?b.recipients.length:0;if(!confirm("Send this personalized text to "+n+" "+(b?b.brand:"")+" creators who have not posted? Each gets their own {firstName}."))return;fetch("/api/sms-communication/followup/"+id+"/send",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({body:body})}).then(function(r){return r.json();}).then(function(res){if(res.error){alert("Error: "+res.error);}else{alert("Sent to "+res.sent+" of "+res.total+" creators."+(res.firstError?" First error: "+res.firstError:""));}load();});}',
'function del(id){if(!confirm(\"Delete this draft? This cannot be undone.\"))return;fetch(\"/api/sms-communication/blasts/\"+id,{method:\"DELETE\",credentials:\"include\"}).then(function(r){return r.json();}).then(function(res){if(res.error){alert(\"Error: \"+res.error);}else{load();}});}',
'function load(){fetch("/api/sms-communication/blasts",{credentials:"include"}).then(function(r){return r.json();}).then(function(d){DATA=d.blasts||[];EVENTS=d.events||[];BRANDS=d.brands||[];fillBrands();render();});}',
'function loadSent(){fetch("/api/sms-communication/sent?limit=200",{credentials:"include"}).then(function(r){return r.json();}).then(function(d){SENT=d.sent||[];SENT_LOADED=true;render();}).catch(function(){SENT_LOADED=true;render();});}',
'load();',
'</script></body></html>',
  ].join('\n');
}

// ─── Mount ────────────────────────────────────────────────��──────────────────
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

  // Approval page (canonical)
  app.get('/sms-communication', requireAdmin, (req, res) => {
    res.set('Content-Type', 'text/html').send(pageHtml());
  });
  // Legacy path -> redirect to canonical
  app.get('/creator-cadence', requireAdmin, (req, res) => res.redirect(301, '/sms-communication'));
  app.get('/sms-communications', requireAdmin, (req, res) => res.redirect(301, '/sms-communication'));

  // Build the full brand list for the dropdown: client brands from brands.json
  // (clients[].name) MERGED with any brands that already have blasts.
  function loadBrandList() {
    const set = {};
    try {
      const bj = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'brands.json'), 'utf8'));
      const clients = Array.isArray(bj) ? bj : (bj.clients || []);
      clients.forEach(b => { const n = b && (b.name || b.brandName); if (n) set[brandSlug(n)] = n; });
    } catch (_) {}
    try { loadBlasts(DATA_DIR).forEach(b => { if (b.brand) set[b.brandSlug || brandSlug(b.brand)] = b.brand; }); } catch (_) {}
    return Object.keys(set).map(k => ({ slug: k, name: set[k] })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Pull flagged-creator follow-up lists from Sisyphus proxy and upsert blasts.
  async function syncFollowups(blasts) {
    const SIS_PROXY = `http://localhost:${process.env.PORT || process.env.DASHBOARD_PORT || 3457}/api/sms-communication/followup/lists`;
    let lists;
    try {
      const resp = await axios.get(SIS_PROXY, {
        timeout: 8000,
        headers: { 'x-ic-admin-key': process.env.IC_ADMIN_KEY || '' },
      });
      lists = resp.data;
    } catch (_) { return; } // upstream unavailable — leave existing blasts untouched

    const ready = (lists && lists.ready && Array.isArray(lists.ready.creators)) ? lists.ready.creators : [];
    if (!ready.length) return;

    // Group by brand (each creator has a .brand or derive from first)
    const byBrand = {};
    for (const c of ready) {
      const b = c.brand || 'Unknown Brand';
      if (!byBrand[b]) byBrand[b] = [];
      byBrand[b].push(c);
    }

    const FOLLOWUP_TEMPLATE = (brand) =>
      `Hey {firstName}! You grabbed your ${brand} product but haven't posted yet — let's fix that 👁️ Even one quick video gets you in the algorithm and earning. Need anything (hook ideas, product Qs)? Just reply here.`;

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let changed = false;

    for (const [brand, creators] of Object.entries(byBrand)) {
      const slug = brandSlug(brand);
      const baseId = `${slug}-followup`;
      const existingDraft = blasts.find(b => b.id === baseId && b.cadence === 'followup' && b.status === 'draft');
      const recipients = creators.filter(c => c.phone && (c.contactId || c.creatorId)).map(c => ({
        handle: c.handle || '', name: c.name || c.handle || '',
        firstName: c.firstName || (c.name || c.handle || '').split(' ')[0] || c.handle || '',
        phone: c.phone, contactId: c.contactId || c.creatorId || '',
      }));
      const skipped = creators.filter(c => !c.phone || (!c.contactId && !c.creatorId)).map(c => ({
        handle: c.handle || '', name: c.name || c.handle || '', reason: 'no phone on file',
      }));
      if (!recipients.length) continue;

      if (existingDraft) {
        existingDraft.recipients = recipients;
        existingDraft.skipped = skipped;
        changed = true;
      } else {
        // Skip if a sent blast exists with the base id (use date-suffix for next cycle)
        const sentExists = blasts.find(b => b.id === baseId && b.cadence === 'followup' && b.status === 'sent');
        const id = sentExists ? `${baseId}-${today}` : baseId;
        if (blasts.find(b => b.id === id)) continue;
        blasts.push({
          id, cadence: 'followup', brand, brandSlug: slug, step: 'FOLLOWUP',
          label: `Non-poster follow-up · ${brand}`,
          audienceTag: null, recipients, skipped,
          body: FOLLOWUP_TEMPLATE(brand),
          status: 'draft', createdAt: new Date().toISOString(), sentAt: null, sentCount: 0,
        });
        changed = true;
      }
    }

    if (changed) saveBlasts(DATA_DIR, blasts);
  }

  // List blasts (sync first so new brands show up). Read-only payload.
  app.get('/api/sms-communication/blasts', requireAdmin, async (req, res) => {
    try {
      const blasts = syncBlasts();
      await syncFollowups(blasts).catch(() => {});
      res.json({ blasts: loadBlasts(DATA_DIR), events: EVENT_TRIGGERS, brands: loadBrandList() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Recently-sent audit feed (every outbound SMS, all sources). Read-only.
  app.get('/api/sms-communication/sent', requireAdmin, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      res.json({ sent: loadSentLog(DATA_DIR).slice(0, limit) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Approve & send a blast. Body may carry edited copy.
  app.use('/api/sms-communication', require('express').json({ limit: '256kb' }));
  app.post('/api/sms-communication/blasts/:id/send', requireAdmin, async (req, res) => {
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

  // Per-recipient send for followup blasts (cadence==='followup').
  // Uses existing sendSms() which already substitutes {firstName} and logs to sent feed.
  app.post('/api/sms-communication/followup/:id/send', requireAdmin, async (req, res) => {
    const blasts = loadBlasts(DATA_DIR);
    const b = blasts.find(x => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: 'not found' });
    if (b.cadence !== 'followup') return res.status(400).json({ error: 'not a followup blast' });
    if (b.status === 'sent') return res.status(400).json({ error: 'already sent' });
    if (!process.env.GHL_API_KEY || !LOC()) return res.status(500).json({ error: 'GHL not configured' });
    const body = (typeof req.body.body === 'string' && req.body.body.trim()) ? req.body.body.trim() : b.body;
    const recipients = Array.isArray(b.recipients) ? b.recipients : [];
    let sent = 0, fail = 0, firstError = null;
    for (const r of recipients) {
      try {
        await sendSms(
          { id: r.contactId, firstName: r.firstName || r.name || '', contactName: r.name || r.handle || '' },
          body
        );
        sent++;
      } catch (e) {
        fail++;
        if (!firstError) firstError = e.response?.data?.message || e.message;
      }
    }
    b.status = 'sent'; b.sentAt = new Date().toISOString(); b.sentCount = sent;
    saveBlasts(DATA_DIR, blasts);
    res.json({ ok: true, total: recipients.length, sent, fail, firstError: firstError || null });
  });

  // Create an ad-hoc manual draft blast. Appears in the console as a draft;
  // send stays gated behind the existing /blasts/:id/send approval button.
  app.post('/api/sms-communication/blasts/manual', requireAdmin, (req, res) => {
    try {
      const body = String(req.body.body || '').trim();
      const audienceTag = String(req.body.audienceTag || '').trim();
      const brand = String(req.body.brand || '').trim();
      const label = String(req.body.label || '').trim() || (brand ? brand + ' · manual reminder' : 'Manual reminder');
      if (!body) return res.status(400).json({ error: 'body required' });
      if (!audienceTag) return res.status(400).json({ error: 'audienceTag required' });
      const blasts = loadBlasts(DATA_DIR);
      const blast = {
        id: 'manual-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        cadence: 'manual',
        brand: brand || null,
        brandSlug: brand ? brandSlug(brand) : null,
        label,
        audienceTag,
        body,
        status: 'draft',
        createdAt: new Date().toISOString(),
      };
      blasts.push(blast);
      saveBlasts(DATA_DIR, blasts);
      res.json({ ok: true, blast });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Delete a draft blast (manual or otherwise). Sent blasts are protected.
  app.delete('/api/sms-communication/blasts/:id', requireAdmin, (req, res) => {
    try {
      const blasts = loadBlasts(DATA_DIR);
      const b = blasts.find(x => x.id === req.params.id);
      if (!b) return res.status(404).json({ error: 'not found' });
      if (b.status === 'sent') return res.status(400).json({ error: 'cannot delete a sent blast' });
      const next = blasts.filter(x => x.id !== req.params.id);
      saveBlasts(DATA_DIR, next);
      res.json({ ok: true, deleted: req.params.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Start the scheduled-SMS drain loop (every 60s). Guard against double-start.
  if (!global.__ccCadenceDrain) {
    global.__ccCadenceDrain = setInterval(() => {
      drainScheduled(DATA_DIR).catch(e => console.error('[creator-cadence] drain:', e.message));
    }, 60 * 1000);
    if (global.__ccCadenceDrain.unref) global.__ccCadenceDrain.unref();
  }

  console.log('[sms-communication] mounted at /sms-communication');
}

module.exports = { mount, buildLaunchBlasts, buildWeeklyBlast, brandSlug, enqueueScheduledSms, logSentSms, loadSentLog, COMMUNITY_WELCOME_BODY };
