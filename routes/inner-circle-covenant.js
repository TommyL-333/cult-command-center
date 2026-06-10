// ─── Inner Circle — Covenant route ────────────────────────────────────────────
// Creator commits ("makes covenant") to a brand → Lark DM to Hasan so he can
// manually send the TikTok target collab invite. MVP flow until the TikTok
// Creator App is approved (no direct TC issuance, no video uploads).
//
// Mounted from dashboard-server.js BEFORE app.use(requireAuth) because creators
// authenticate with ic_session tokens, not Cloudflare Access.
//
// Frontend contract (views/inner-circle.html → makeCovenant()):
//   POST /api/inner-circle/covenant
//   Authorization: Bearer <ic_session token>
//   { creatorName, brandName, tiktokHandle }
//   → 200 { ok: true } on success (anything else shows an error to the creator)

const fs = require('fs');
const path = require('path');

const HASAN_OPEN_ID = 'ou_c8f157f2f18a8c4ffe6a20d3971348e1'; // from LARK_TEAM_IDS map
const DATA_DIR = process.env.DATA_DIR || '/data';
const COVENANT_LOG = path.join(DATA_DIR, 'inner-circle-covenants.jsonl');

module.exports = (app, { requireCreatorSession, axios, express, getLarkTenantToken }) => {
  app.post('/api/inner-circle/covenant', requireCreatorSession, express.json(), async (req, res) => {
    const { creatorName, brandName, tiktokHandle } = req.body || {};
    if (!brandName) return res.status(400).json({ ok: false, error: 'brandName required' });

    const name = creatorName || req.user?.name || 'Unknown creator';
    const handle = (tiktokHandle || req.user?.tiktok_handle || '').replace(/^@/, '');

    // Durable record first — if Lark is down, the covenant is never lost.
    try {
      fs.appendFileSync(COVENANT_LOG, JSON.stringify({
        at: new Date().toISOString(),
        creatorId: req.user?.id ?? null,
        creatorName: name,
        tiktokHandle: handle,
        brandName,
      }) + '\n');
    } catch (e) {
      console.error('[covenant] log write failed:', e.message);
    }

    // Notify Hasan in Lark. A notify failure must not fail the covenant for the
    // creator — it is logged above and surfaced in server logs for manual retry.
    let notified = false;
    try {
      const token = await getLarkTenantToken();
      if (token) {
        const text =
          `🤝 Inner Circle covenant\n\n` +
          `Creator: ${name}${handle ? ` (@${handle})` : ''}\n` +
          `Brand: ${brandName}\n\n` +
          `Action: manually send the ${brandName} target collab invite to this creator (MVP flow).`;
        await axios.post(
          'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id',
          { receive_id: HASAN_OPEN_ID, msg_type: 'text', content: JSON.stringify({ text }) },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
        );
        notified = true;
      } else {
        console.error('[covenant] no Lark tenant token — LARK_APP_ID/LARK_APP_SECRET missing?');
      }
    } catch (e) {
      console.error('[covenant] Lark notify failed:', e.response?.data || e.message);
    }

    console.log(`[covenant] ${name}${handle ? ' @' + handle : ''} → ${brandName} (lark notified: ${notified})`);
    return res.json({ ok: true, notified });
  });
};
