/**
 * Client Portal — Intercom Messenger identity (Phase 1, brand side).
 *
 * Mirrors the Inner Circle identity endpoint (routes/inner-circle-sqlite.js)
 * but for logged-in CLIENT (brand) sessions. user_type is set SERVER-SIDE from
 * the client session, so it is always trustworthy. Returns:
 *   - app_id, user_id, name, email, created_at  (for the Messenger boot)
 *   - intercom_user_jwt (HS256, signed with INTERCOM_IDENTITY_SECRET) for
 *     Messenger Security — sensitive attrs nested under custom_attributes.
 * Also fires a non-blocking REST upsert (INTERCOM_ACCESS_TOKEN) to write the
 * segmentation custom attributes, since they are messenger_writable:false and
 * cannot be set through the (even JWT-signed) Messenger boot.
 *
 * Mount: require('./routes/client-intercom-identity')(app, { requireClientSession, loadBrands });
 */
module.exports = function (app, deps) {
  const { requireClientSession, loadBrands } = deps || {};
  if (!app || typeof requireClientSession !== 'function' || typeof loadBrands !== 'function') {
    console.error('[client-intercom-identity] missing deps; not mounting');
    return;
  }

  const TEAM_EMAILS = new Set(
    String(process.env.INTERCOM_TEAM_EMAILS || 'tommy@cultcontent.cc,hasan@cultcontent.cc,shayan@cultcontent.cc')
      .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  );

  app.get('/api/client/intercom-identity', requireClientSession, (req, res) => {
    try {
      const brands = loadBrands();
      const brand = (brands.clients || []).find(b => b.id === req.session.clientBrandId);
      if (!brand) return res.status(404).json({ error: 'Brand not found' });

      const email = String(brand.loginEmail || brand.email || '').trim();
      const userId = 'client_' + brand.id;
      const isTeam = email && TEAM_EMAILS.has(email.toLowerCase());

      let createdUnix = Math.floor(Date.now() / 1000);
      if (brand.onboardedAt || brand.createdAt) {
        const t = Date.parse(String(brand.onboardedAt || brand.createdAt));
        if (!isNaN(t)) createdUnix = Math.floor(t / 1000);
      }

      const payload = {
        app_id: process.env.INTERCOM_APP_ID || 'wf9rqc2t',
        user_id: userId,
        name: brand.name || 'Cult Content Client',
        email: email || undefined,
        created_at: createdUnix,
        user_type: isTeam ? 'team' : 'client',
        brand: brand.name || undefined,
        portal: 'client'
      };

      // JWT (Messenger Security). Custom attrs MUST be nested under
      // custom_attributes or Intercom silently ignores them.
      const secret = process.env.INTERCOM_IDENTITY_SECRET;
      if (secret) {
        try {
          const crypto = require('crypto');
          const b64url = (buf) => Buffer.from(buf).toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          const nowSec = Math.floor(Date.now() / 1000);
          const header = { alg: 'HS256', typ: 'JWT' };
          const jwtPayload = {
            user_id: userId,
            email: email || undefined,
            name: payload.name,
            created_at: createdUnix,
            custom_attributes: {
              user_type: payload.user_type,
              brand: brand.name || undefined,
              portal: 'client'
            },
            iat: nowSec,
            exp: nowSec + 3600
          };
          const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(jwtPayload));
          const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          payload.intercom_user_jwt = signingInput + '.' + signature;
        } catch (e) {
          console.error('[client-intercom-identity] jwt failed:', e.message);
        }
      }

      // Intercom segmentation attrs are messenger_writable:false, so they must be
      // written via REST. POST /contacts does NOT upsert (409s on existing
      // external_id) — so we search by external_id, then PUT by internal id;
      // only POST-create when the contact does not yet exist. Fully non-blocking.
      const icTok = process.env.INTERCOM_ACCESS_TOKEN;
      if (icTok) {
        const icAttrs = { user_type: payload.user_type, brand: brand.name || undefined, portal: 'client' };
        const icHeaders = (len) => ({
          'Authorization': 'Bearer ' + icTok,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Intercom-Version': '2.11',
          'Content-Length': len
        });
        const icCall = (method, path, payloadObj, cb) => {
          try {
            const b = JSON.stringify(payloadObj);
            const r = require('https').request(
              { hostname: 'api.intercom.io', path, method, headers: icHeaders(Buffer.byteLength(b)) },
              (resp) => { let d = ''; resp.on('data', x => d += x); resp.on('end', () => cb(null, resp.statusCode, d)); }
            );
            r.on('error', (e) => cb(e)); r.write(b); r.end();
          } catch (e) { cb(e); }
        };
        icCall('POST', '/contacts/search',
          { query: { field: 'external_id', operator: '=', value: userId } },
          (err, sc, sbody) => {
            if (err) { console.error('[client-intercom-identity] search err:', err.message); return; }
            let found = null;
            try { const j = JSON.parse(sbody); if (j && j.data && j.data[0]) found = j.data[0].id; } catch (_) {}
            if (found) {
              icCall('PUT', '/contacts/' + found, { custom_attributes: icAttrs }, (e2, c2, b2) => {
                if (e2) return console.error('[client-intercom-identity] put err:', e2.message);
                if (c2 >= 300) console.error('[client-intercom-identity] put', c2, String(b2).slice(0,200));
              });
            } else {
              icCall('POST', '/contacts',
                { external_id: userId, email: email || undefined, name: payload.name, custom_attributes: icAttrs },
                (e3, c3, b3) => {
                  if (e3) return console.error('[client-intercom-identity] create err:', e3.message);
                  if (c3 >= 300 && c3 !== 409) console.error('[client-intercom-identity] create', c3, String(b3).slice(0,200));
                });
            }
          });
      }
      return res.json(payload);
    } catch (e) {
      console.error('[client-intercom-identity] GET failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  console.log('[client-intercom-identity] mounted GET /api/client/intercom-identity');
};
