// routes/link-tracker.js
// ─────────────────────────────────────────────────────────────────────────────
// Creator-link click tracking. Answers the question the team raised on the
// June 29 2026 Manifestation Monday call: "are creators even opening the
// portal link?" — so every July offer experiment is measurable, not vibes.
//
// HOW IT WORKS
//   • Creator DMs carry a tracked link:  /creators/{slug}?ref={handle}
//   • The existing /creators/:brandSlug route calls trackClick(slug, handle, req)
//     (a tiny, fire-and-forget hook — never throws, never blocks page render).
//   • Clicks are appended to DATA_DIR/link-clicks.jsonl (durable on the volume).
//   • mount(app) exposes read-only metrics endpoints for the dashboard / Hasan
//     & Shayan, gated by portal-admin OR the IC_ADMIN_KEY header.
//
// No schema migrations, no DB. Append-only JSONL is the system of record;
// aggregates are computed on read. Honest by construction: if the log file
// doesn't exist yet, counts are 0 — never fabricated.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

let _DATA_DIR = process.env.DATA_DIR || '/data';
function clicksFile() { return path.join(_DATA_DIR, 'link-clicks.jsonl'); }

// Normalize a handle: strip @, lowercase, trim. Junk/empty -> null.
function normHandle(h) {
  if (!h || typeof h !== 'string') return null;
  const v = h.replace(/^@+/, '').trim().toLowerCase();
  if (!v || v.length > 80) return null;
  if (['5000', 'no', 'dsadsa', 'null', 'undefined'].includes(v)) return null;
  return v;
}

// ── WRITE: record one click. Fire-and-forget. NEVER throws. ──────────────────
function trackClick(slug, handle, req) {
  try {
    const h = normHandle(handle);
    const row = {
      ts: new Date().toISOString(),
      slug: slug ? String(slug).slice(0, 80) : null,
      handle: h, // may be null (untracked / direct visit)
      ref: !!h,  // true = came from a creator-specific tracked link
      ua: req && req.headers ? String(req.headers['user-agent'] || '').slice(0, 200) : '',
      ip: req ? String(
        (req.headers && (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'])) ||
        (req.socket && req.socket.remoteAddress) || ''
      ).split(',')[0].trim() : '',
    };
    fs.appendFile(clicksFile(), JSON.stringify(row) + '\n', () => {});
  } catch (_) { /* tracking must never break a page render */ }
}

// ── READ: load + parse all clicks (newest-first). ────────────────────────────
function loadClicks(limit) {
  let raw = '';
  try { raw = fs.readFileSync(clicksFile(), 'utf8'); }
  catch (_) { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (_) {}
  }
  rows.reverse();
  return limit ? rows.slice(0, limit) : rows;
}

function sinceMs(days) {
  if (!days || days <= 0) return 0;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

// ── AGGREGATE: per-brand + per-creator click counts over a window. ───────────
function summarize(days) {
  const cutoff = sinceMs(days);
  const all = loadClicks();
  const window = all.filter(r => !cutoff || Date.parse(r.ts) >= cutoff);

  const totals = {
    totalClicks: window.length,
    trackedClicks: window.filter(r => r.ref).length,     // came from a creator link
    directClicks: window.filter(r => !r.ref).length,     // bare /creators/{slug} visit
    uniqueCreators: new Set(window.filter(r => r.handle).map(r => r.handle)).size,
  };

  const byBrand = {};
  const byCreator = {};
  for (const r of window) {
    const slug = r.slug || 'unknown';
    if (!byBrand[slug]) byBrand[slug] = { slug, clicks: 0, tracked: 0, creators: new Set() };
    byBrand[slug].clicks++;
    if (r.ref) byBrand[slug].tracked++;
    if (r.handle) byBrand[slug].creators.add(r.handle);

    if (r.handle) {
      const key = `${slug}::${r.handle}`;
      if (!byCreator[key]) byCreator[key] = { slug, handle: r.handle, clicks: 0, lastClick: r.ts };
      byCreator[key].clicks++;
      if (Date.parse(r.ts) > Date.parse(byCreator[key].lastClick)) byCreator[key].lastClick = r.ts;
    }
  }

  const brands = Object.values(byBrand)
    .map(b => ({ slug: b.slug, clicks: b.clicks, tracked: b.tracked, uniqueCreators: b.creators.size }))
    .sort((a, b) => b.clicks - a.clicks);

  const creators = Object.values(byCreator).sort((a, b) => b.clicks - a.clicks);

  return { windowDays: days || 'all', generatedAt: new Date().toISOString(), totals, brands, creators };
}

// ── MOUNT: read-only metrics endpoints. ──────────────────────────────────────
function mount(app, opts = {}) {
  if (opts.DATA_DIR) _DATA_DIR = opts.DATA_DIR;

  // Auth: portal-admin session OR IC_ADMIN_KEY header (server-to-server / Shayan tool).
  function gate(req, res, next) {
    if (req.session && req.session.isPortalAdmin) return next();
    const key = req.headers['x-ic-admin-key'] || req.query.key;
    if (key && process.env.IC_ADMIN_KEY && key === process.env.IC_ADMIN_KEY) return next();
    return res.status(401).json({ error: 'Not authorized' });
  }

  // Summary aggregates. ?days=7 (default 14), ?days=0 = all-time.
  app.get('/api/link-metrics/summary', gate, (req, res) => {
    const days = req.query.days != null ? parseInt(req.query.days, 10) : 14;
    res.json(summarize(Number.isFinite(days) ? days : 14));
  });

  // Raw recent clicks (debug / audit). ?limit=100
  app.get('/api/link-metrics/recent', gate, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    res.json({ clicks: loadClicks(limit) });
  });

  console.log('[link-tracker] metrics mounted: /api/link-metrics/summary, /api/link-metrics/recent');
}

module.exports = { trackClick, loadClicks, summarize, mount };
