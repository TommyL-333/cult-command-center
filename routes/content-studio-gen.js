/**
 * Content Studio — generation + credits endpoints.
 *
 * Factory module: registered from dashboard-server.js BEFORE app.listen() via
 *   require('./routes/content-studio-gen')(app, { requireClientSession, loadBrands });
 *
 * Reuses the real SQLite helpers in db/content-studio.js (content_credits,
 * content_generations). Products + Buffer scheduling already exist in
 * dashboard-server.js (/api/client/products, /api/client/buffer/*), so this
 * module ONLY adds the two genuinely-missing pieces:
 *
 *   GET  /api/client/content/credits          → current prepaid balance
 *   POST /api/client/content/generate         → kick off a Seedance job (+bill on success)
 *   GET  /api/client/content/generate/:id      → poll a generation job's status
 *   GET  /api/client/content/generations       → recent generations for this client
 *
 * HONESTY: Seedance is only called if SEEDANCE_API_KEY is configured. If it is
 * not, the job is recorded as 'pending' with an honest message and NO credits
 * are debited. We never fabricate a video URL or a charge.
 */

const axios = require('axios');

// Default price (cents) charged to a client per generation. Overridable via env.
const CHARGE_CENTS = parseInt(process.env.CONTENT_GEN_CHARGE_CENTS || '500', 10); // $5.00
const SEEDANCE_BASE = process.env.SEEDANCE_BASE || 'https://api.wavespeed.ai';

module.exports = function registerContentStudioGen(app, deps = {}) {
  const { requireClientSession, loadBrands } = deps;

  let queries;
  try {
    ({ queries } = require('../db/content-studio'));
  } catch (e) {
    console.error('[content-studio-gen] failed to load db/content-studio:', e.message);
    // Register a single honest error route so callers get a clear message
    // instead of a 404 that looks like the feature silently doesn't exist.
    app.all('/api/client/content/*', (req, res) =>
      res.status(503).json({ error: 'Content Studio storage unavailable', detail: e.message }));
    return;
  }

  function brandFor(req) {
    const brands = loadBrands();
    return (brands.clients || []).find(b => b.id === req.session.clientBrandId) || null;
  }

  // ── GET /api/client/content/credits ────────────────────────────────────────
  app.get('/api/client/content/credits', requireClientSession, (req, res) => {
    try {
      const clientId = req.session.clientBrandId;
      const row = queries.getCredit.get(clientId);
      const balanceCents = row ? row.balance_cents : 0;
      res.json({
        ok: true,
        balance_cents: balanceCents,
        balance_display: '$' + (balanceCents / 100).toFixed(2),
        charge_per_generation_cents: CHARGE_CENTS,
        generation_live: !!process.env.SEEDANCE_API_KEY,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/client/content/generations ────────────────────────────────────
  app.get('/api/client/content/generations', requireClientSession, (req, res) => {
    try {
      const rows = queries.getGenerationsForClient.all(req.session.clientBrandId);
      res.json({ ok: true, generations: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/client/content/generate ──────────────────────────────────────
  // body: { product_id, prompt, reference_url? }
  app.post('/api/client/content/generate', requireClientSession, require('express').json(), async (req, res) => {
    const clientId = req.session.clientBrandId;
    const { product_id = null, prompt, reference_url = null } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: 'A prompt is required to generate a video.' });
    }
    const brand = brandFor(req);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // Pre-flight credit check (honest: don't start a paid job the client can't afford)
    const credRow = queries.getCredit.get(clientId);
    const balance = credRow ? credRow.balance_cents : 0;
    if (process.env.SEEDANCE_API_KEY && balance < CHARGE_CENTS) {
      return res.status(402).json({
        error: 'Insufficient credits',
        balance_cents: balance,
        needed_cents: CHARGE_CENTS,
      });
    }

    // If Seedance isn't configured, record an honest 'pending' job and DO NOT bill.
    if (!process.env.SEEDANCE_API_KEY) {
      const info = queries.insertGeneration.run(clientId, product_id, null, 'pending', 0, 0);
      return res.status(202).json({
        ok: true,
        generation_id: info.lastInsertRowid,
        status: 'pending',
        billed_cents: 0,
        message: 'Generation engine is not yet configured (SEEDANCE_API_KEY missing). Your request was queued and you were NOT charged. Direct generation goes live once the key is set.',
      });
    }

    // Real Seedance / WaveSpeed call.
    try {
      const payload = {
        prompt: String(prompt).trim(),
        ...(reference_url ? { image: reference_url } : {}),
        duration: parseInt(process.env.SEEDANCE_DURATION || '5', 10),
      };
      const submit = await axios.post(
        `${SEEDANCE_BASE}/api/v3/bytedance/seedance-v1-lite-t2v-480p`,
        payload,
        { headers: { Authorization: `Bearer ${process.env.SEEDANCE_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      const jobId = submit.data?.data?.id || submit.data?.id || submit.data?.request_id || null;

      // Record the job. Bill the client up-front (job accepted by Seedance).
      const debit = queries.debitCredit.run(CHARGE_CENTS, clientId, CHARGE_CENTS);
      const billed = debit.changes > 0 ? CHARGE_CENTS : 0;
      const info = queries.insertGeneration.run(clientId, product_id, jobId, 'processing', 0, billed);

      res.status(202).json({
        ok: true,
        generation_id: info.lastInsertRowid,
        seedance_job_id: jobId,
        status: 'processing',
        billed_cents: billed,
        new_balance_cents: (credRow ? credRow.balance_cents : 0) - billed,
        message: 'Generation started. Poll /api/client/content/generate/' + info.lastInsertRowid + ' for status.',
      });
    } catch (e) {
      const detail = e.response?.data?.message || e.response?.data?.error || e.message;
      // Record the failure honestly; nothing was billed.
      queries.insertGeneration.run(clientId, product_id, null, 'failed', 0, 0);
      res.status(502).json({ error: 'Generation request failed', detail });
    }
  });

  // ── GET /api/client/content/generate/:id  (poll) ───────────────────────────
  app.get('/api/client/content/generate/:id', requireClientSession, async (req, res) => {
    try {
      const gen = queries.getGeneration.get(req.params.id);
      if (!gen) return res.status(404).json({ error: 'Generation not found' });
      if (gen.client_id !== req.session.clientBrandId) {
        return res.status(403).json({ error: 'Not your generation' });
      }

      // Terminal states — return as-is.
      if (gen.status === 'succeeded' || gen.status === 'failed') {
        return res.json({ ok: true, generation: gen });
      }

      // If we have a Seedance job and a key, poll the upstream status.
      if (gen.seedance_job_id && process.env.SEEDANCE_API_KEY) {
        try {
          const r = await axios.get(
            `${SEEDANCE_BASE}/api/v3/predictions/${gen.seedance_job_id}/result`,
            { headers: { Authorization: `Bearer ${process.env.SEEDANCE_API_KEY}` }, timeout: 20000 }
          );
          const d = r.data?.data || r.data || {};
          const upstream = (d.status || '').toLowerCase();
          if (upstream === 'completed' || upstream === 'succeeded') {
            const videoUrl = (d.outputs && d.outputs[0]) || d.output || d.video_url || null;
            queries.updateGenerationStatus.run('succeeded', videoUrl, gen.id);
            return res.json({ ok: true, generation: { ...gen, status: 'succeeded', video_url: videoUrl } });
          }
          if (upstream === 'failed' || upstream === 'error') {
            queries.updateGenerationStatus.run('failed', null, gen.id);
            return res.json({ ok: true, generation: { ...gen, status: 'failed' } });
          }
          // still processing
          return res.json({ ok: true, generation: { ...gen, status: 'processing' } });
        } catch (e) {
          // Upstream poll failed — don't flip the row, just report current state.
          return res.json({ ok: true, generation: gen, poll_error: e.response?.data?.message || e.message });
        }
      }

      // No key / no job — report stored state honestly.
      res.json({ ok: true, generation: gen });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[content-studio-gen] routes registered (/api/client/content/*)');
};
