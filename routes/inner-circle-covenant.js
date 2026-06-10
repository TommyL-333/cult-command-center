// ─── Inner Circle — Covenant route ───────────────────────────────────────────
// Creator commits ("makes covenant") to a brand → Lark message to the ALERT
// CHANNEL for Hasan so he can manually send the TikTok target collab invite.
// MVP flow until the TikTok Creator App is approved (no direct TC issuance,
// no video uploads).
//
// Scope (Tommy, June 2026): on brand selection, fire to the alert channel:
//   "🤝 Inner Circle Covenant: {creator} (@{handle}) committed to {brand} — send target collab invite"
//
// Delivery order (never lose the covenant — durable jsonl log written first):
//   1. Relay → ${RAILWAY_URL}/command (same pattern as the Inner Circle toggle
//      alert in dashboard-server.js ~line 3767; posts to the Lark alert channel)
//   2. Direct Lark im/v1/messages → LARK_ALERT_CHAT_ID (chat_id)
//   3. Direct Lark DM → Hasan's open_id (last resort)
//
// Mounted from dashboard-server.js BEFORE app.use(requireAuth) because creators
// authenticate with ic_session tokens, not Cloudflare Access. Session middleware
// is the WORKING SQLite one (requireSqliteSession from routes/inner-circle-sqlite.js,
// which sets req.icCreator). The legacy supabase requireCreatorSession is broken
// in production (supabase client never defined) — kept only as a dep fallback.
//
// Frontend contract (views/inner-circle.html → makeCovenant()):
//   POST /api/inner-circle/covenant
//   Authorization: Bearer <ic_session token>  (or ic_session cookie)
//   { creatorName, brandName, tiktokHandle }
//   → 200 { ok: true } on success (anything else shows an error to the creator)

const fs = require('fs');
const path = require('path');

const HASAN_OPEN_ID = 'ou_c8f157f2f18a8c4ffe6a20d3971348e1'; // from LARK_TEAM_IDS map
const DATA_DIR = process.env.DATA_DIR || '/data';
const COVENANT_LOG = path.join(DATA_DIR, 'inner-circle-covenants.jsonl');
const RELAY_URL = (process.env.RAILWAY_URL || 'https://cultcontent-server-production.up.railway.app') + '/command';

module.exports = (app, deps = {}) => {
  const { axios, express, getLarkTenantToken } = deps;
  // Prefer the working SQLite session middleware; fall back to legacy if absent.
  const requireSession = deps.requireSession || deps.requireCreatorSession;

  app.post('/api/inner-circle/covenant', requireSession, express.json(), async (req, res) => {
    const { creatorName, brandName, tiktokHandle } = req.body || {};
    if (!brandName) return res.status(400).json({ ok: false, error: 'brandName required' });

    // SQLite middleware sets req.icCreator (creator_name / creator_handle);
    // legacy supabase middleware set req.user (name / tiktok_handle).
    const sess = req.icCreator || req.user || {};
    const name = (creatorName || sess.creator_name || sess.name || 'Unknown creator').toString().trim().slice(0, 120);
    const handle = (tiktokHandle || sess.creator_handle || sess.tiktok_handle || '')
      .toString().trim().replace(/^@/, '').slice(0, 80);

    // Durable record first — if Lark is down, the covenant is never lost.
    try {
      fs.appendFileSync(COVENANT_LOG, JSON.stringify({
        at: new Date().toISOString(),
        creatorId: sess.id ?? null,
        creatorName: name,
        tiktokHandle: handle,
        brandName,
      }) + '\n');
    } catch (e) {
      console.error('[covenant] log write failed:', e.message);
    }

    // Exact format per scope.
    const text = `🤝 Inner Circle Covenant: ${name}${handle ? ` (@${handle})` : ''} committed to ${brandName} — send target collab invite`;

    // Notify the alert channel. A notify failure must not fail the covenant for
    // the creator — it is logged above and surfaced in server logs for retry.
    let notified = false;
    let via = null;

    // 1) Relay → alert channel (primary, proven pattern)
    try {
      await axios.post(RELAY_URL, {
        text,
        context: 'Inner Circle Covenant',
        source: 'Inner Circle Portal',
      }, { timeout: 8000 });
      notified = true;
      via = 'relay';
    } catch (e) {
      console.error('[covenant] relay notify failed:', e.response?.data || e.message);
    }

    // 2) Direct Lark → alert channel chat_id (fallback)
    if (!notified) {
      try {
        const token = await getLarkTenantToken();
        const chatId = process.env.LARK_ALERT_CHAT_ID;
        if (token && chatId) {
          await axios.post(
            'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id',
            { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
          );
          notified = true;
          via = 'lark-chat';
        }
      } catch (e) {
        console.error('[covenant] direct chat notify failed:', e.response?.data || e.message);
      }
    }

    // 3) DM Hasan directly (last resort)
    if (!notified) {
      try {
        const token = await getLarkTenantToken();
        if (token) {
          await axios.post(
            'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id',
            { receive_id: HASAN_OPEN_ID, msg_type: 'text', content: JSON.stringify({ text }) },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
          );
          notified = true;
          via = 'hasan-dm';
        }
      } catch (e) {
        console.error('[covenant] Hasan DM notify failed:', e.response?.data || e.message);
      }
    }

    console.log(`[covenant] ${name}${handle ? ' @' + handle : ''} → ${brandName} (notified: ${notified}${via ? ' via ' + via : ''})`);
    return res.json({ ok: true, notified });
  });
};
