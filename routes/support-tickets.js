/**
 * routes/support-tickets.js
 * Centralized support tickets — questions, concerns, suggestions — for both
 * client (brand) submitters and Inner Circle creator submitters.
 *
 * Client side (requireClientSession, portal.cultcontent.cc):
 *   POST /api/client/support/submit      { type, message } -> creates a ticket
 *   GET  /api/client/support/my-tickets  -> this client's own submitted tickets
 *
 * Creator side (requireSqliteSession — Inner Circle bearer-token/cookie auth):
 *   POST /api/inner-circle/support/submit      { type, message } -> creates a ticket
 *   GET  /api/inner-circle/support/my-tickets   -> this creator's own submitted tickets
 *
 * Employee side (requireAuth — CF Access, ANY @cultcontent.cc teammate, not
 * just portal admins, since this needs to be visible to "all employees"):
 *   GET  /api/support-tickets/list            -> every ticket, clients AND creators
 *   POST /api/support-tickets/:id/status      { status } -> unopened|opened|flagged
 *   GET  /support-tickets                     -> HTML page for the above
 *
 * Status is exactly one of unopened | opened | flagged. Moving a ticket to
 * "opened" records which teammate did it (from the CF Access email — no
 * separate login for this feature).
 */

'use strict';

const { queries } = require('../db/support-tickets');

const VALID_TYPES = new Set(['question', 'concern', 'suggestion']);
const VALID_STATUSES = new Set(['unopened', 'opened', 'flagged']);

// Turns "daniel.jimenez@cultcontent.cc" into "Daniel Jimenez" — a mechanical
// transform of the real email, never an invented/guessed name.
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  if (!local) return email || 'Unknown';
  return local
    .replace(/[._]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function shapeTicket(row) {
  return {
    id: row.id,
    submitterType: row.submitter_type,
    brandId: row.brand_id,
    brandName: row.brand_name,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorHandle: row.creator_handle,
    type: row.type,
    message: row.message,
    status: row.status,
    openedByEmail: row.opened_by_email,
    openedByName: row.opened_by_name,
    openedAt: row.opened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = function registerSupportTickets(app, deps = {}) {
  const { requireClientSession, requireAuth, requireSqliteSession, loadBrands } = deps;
  if (!app || !requireClientSession || !requireAuth || !requireSqliteSession || !loadBrands) {
    throw new Error('[support-tickets] missing deps: requires { requireClientSession, requireAuth, requireSqliteSession, loadBrands }');
  }

  // ── Client: submit a new ticket ─────────────────────────────────────────
  app.post('/api/client/support/submit', requireClientSession, (req, res) => {
    try {
      const brandId = req.session.clientBrandId;
      const brands = loadBrands();
      const brand = (brands.clients || []).find((b) => b.id === brandId);
      if (!brand) return res.status(404).json({ error: 'Brand not found' });

      const { type, message } = req.body || {};
      const cleanMessage = String(message || '').trim();
      if (!cleanMessage) return res.status(400).json({ error: 'message is required' });
      const cleanType = VALID_TYPES.has(type) ? type : 'question';

      const info = queries.insertClientTicket.run(brandId, brand.name, cleanType, cleanMessage);
      const ticket = queries.getTicketById.get(info.lastInsertRowid);
      res.json({ ok: true, ticket: shapeTicket(ticket) });
    } catch (e) {
      console.error('[support-tickets] submit failed:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Client: view own ticket history + status ────────────────────────────
  app.get('/api/client/support/my-tickets', requireClientSession, (req, res) => {
    try {
      const rows = queries.getTicketsForBrand.all(req.session.clientBrandId);
      res.json({ ok: true, tickets: rows.map(shapeTicket) });
    } catch (e) {
      console.error('[support-tickets] my-tickets failed:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Creator: submit a new ticket ─────────────────────────────────────────
  app.post('/api/inner-circle/support/submit', requireSqliteSession, (req, res) => {
    try {
      const creator = req.icCreator;
      if (!creator || !creator.id) return res.status(401).json({ error: 'Not authenticated' });

      const { type, message } = req.body || {};
      const cleanMessage = String(message || '').trim();
      if (!cleanMessage) return res.status(400).json({ error: 'message is required' });
      const cleanType = VALID_TYPES.has(type) ? type : 'question';

      const info = queries.insertCreatorTicket.run(
        cleanType, cleanMessage, creator.id, creator.creator_name || null, creator.creator_handle || null
      );
      const ticket = queries.getTicketById.get(info.lastInsertRowid);
      res.json({ ok: true, ticket: shapeTicket(ticket) });
    } catch (e) {
      console.error('[support-tickets] creator submit failed:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Creator: view own ticket history + status ────────────────────────────
  app.get('/api/inner-circle/support/my-tickets', requireSqliteSession, (req, res) => {
    try {
      const creator = req.icCreator;
      if (!creator || !creator.id) return res.status(401).json({ error: 'Not authenticated' });
      const rows = queries.getTicketsForCreator.all(creator.id);
      res.json({ ok: true, tickets: rows.map(shapeTicket) });
    } catch (e) {
      console.error('[support-tickets] creator my-tickets failed:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Employee: every ticket, clients AND creators ────────────────────────
  app.get('/api/support-tickets/list', requireAuth, (req, res) => {
    try {
      const rows = queries.getAllTickets.all();
      res.json({ ok: true, tickets: rows.map(shapeTicket) });
    } catch (e) {
      console.error('[support-tickets] list failed:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Employee: change status. Opening a ticket records who opened it. ───
  app.post('/api/support-tickets/:id/status', requireAuth, (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body || {};
      if (!VALID_STATUSES.has(status)) {
        return res.status(400).json({ error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
      }
      const existing = queries.getTicketById.get(id);
      if (!existing) return res.status(404).json({ error: 'Ticket not found' });

      if (status === 'opened') {
        const email = req.userEmail || 'unknown';
        queries.setStatusOpened.run(email, nameFromEmail(email), id);
      } else if (status === 'flagged') {
        queries.setStatusFlagged.run(id);
      } else {
        queries.setStatusUnopened.run(id);
      }

      const updated = queries.getTicketById.get(id);
      res.json({ ok: true, ticket: shapeTicket(updated) });
    } catch (e) {
      console.error('[support-tickets] status update failed:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Employee: the ticket board page itself ──────────────────────────────
  app.get('/support-tickets', requireAuth, (req, res) => {
    res.type('html').send(SUPPORT_TICKETS_HTML);
  });
};

const SUPPORT_TICKETS_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Support Tickets — Cult Content</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e2e8f0;min-height:100vh}
.header{background:rgba(255,255,255,.02);border-bottom:1px solid rgba(255,255,255,.07);padding:20px 24px}
.header h1{font-size:1.3rem;font-weight:800}
.container{max-width:960px;margin:0 auto;padding:32px 24px 60px}
.filters{display:flex;gap:8px;margin-bottom:20px}
.filter-btn{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);color:#94a3b8;padding:7px 14px;border-radius:7px;font-size:.82rem;font-weight:600;cursor:pointer}
.filter-btn.active{background:rgba(0,242,234,.12);border-color:#00f2ea;color:#00f2ea}
.ticket{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:16px 18px;margin-bottom:10px}
.ticket-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px}
.ticket-brand{font-weight:700;font-size:.95rem}
.ticket-source{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:5px;margin-right:8px}
.ticket-source-client{background:rgba(168,85,247,.14);color:#c084fc}
.ticket-source-creator{background:rgba(0,242,234,.12);color:#00f2ea}
.ticket-type{font-size:.72rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-left:8px}
.badge{font-size:.72rem;font-weight:700;padding:3px 9px;border-radius:6px;white-space:nowrap}
.badge-unopened{background:rgba(96,165,250,.12);color:#60a5fa}
.badge-opened{background:rgba(45,212,191,.12);color:#2dd4bf}
.badge-flagged{background:rgba(248,113,113,.14);color:#f87171}
.ticket-msg{font-size:.88rem;color:#cbd5e1;line-height:1.5;margin-bottom:10px;white-space:pre-wrap}
.ticket-meta{font-size:.76rem;color:#64748b;margin-bottom:10px}
.ticket-actions{display:flex;gap:8px}
.action-btn{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);color:#e2e8f0;padding:6px 12px;border-radius:6px;font-size:.78rem;font-weight:600;cursor:pointer}
.action-btn:hover{background:rgba(255,255,255,.09)}
.action-btn.primary{background:linear-gradient(135deg,#00f2ea,#a855f7);border:none;color:#0a0a0f}
.empty{text-align:center;padding:60px 20px;color:#64748b}
</style></head>
<body>
<div class="header"><h1>Support Tickets</h1></div>
<div class="container">
  <div class="filters" id="filters">
    <button class="filter-btn active" data-f="all">All</button>
    <button class="filter-btn" data-f="unopened">Unopened</button>
    <button class="filter-btn" data-f="opened">Opened</button>
    <button class="filter-btn" data-f="flagged">Flagged</button>
  </div>
  <div id="list"><div class="empty">Loading…</div></div>
</div>
<script>
let allTickets = [];
let currentFilter = 'all';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function loadTickets() {
  try {
    const res = await fetch('/api/support-tickets/list');
    if (!res.ok) throw new Error('fetch failed (' + res.status + ')');
    const data = await res.json();
    allTickets = data.tickets || [];
    render();
  } catch (e) {
    document.getElementById('list').innerHTML = '<div class="empty">Could not load tickets — please refresh.</div>';
  }
}

function render() {
  const list = document.getElementById('list');
  const filtered = currentFilter === 'all' ? allTickets : allTickets.filter(t => t.status === currentFilter);
  if (!filtered.length) {
    list.innerHTML = '<div class="empty">No tickets here.</div>';
    return;
  }
  list.innerHTML = filtered.map(t => {
    const opened = t.status === 'opened' && t.openedByName
      ? '<div class="ticket-meta">Opened by ' + esc(t.openedByName) + '</div>' : '';
    const actions = [];
    if (t.status !== 'opened') actions.push('<button class="action-btn primary" onclick="setStatus(' + t.id + ',\\'opened\\')">Open</button>');
    if (t.status !== 'flagged') actions.push('<button class="action-btn" onclick="setStatus(' + t.id + ',\\'flagged\\')">Flag</button>');
    if (t.status !== 'unopened') actions.push('<button class="action-btn" onclick="setStatus(' + t.id + ',\\'unopened\\')">Reset</button>');
    const who = t.submitterType === 'creator'
      ? esc(t.creatorName || t.creatorHandle || 'Creator') + (t.creatorHandle ? ' (@' + esc(t.creatorHandle) + ')' : '')
      : esc(t.brandName);
    const sourceTag = '<span class="ticket-source ticket-source-' + t.submitterType + '">' + t.submitterType + '</span>';
    return '<div class="ticket">'
      + '<div class="ticket-top">'
      + '<div>' + sourceTag + '<span class="ticket-brand">' + who + '</span><span class="ticket-type">' + esc(t.type) + '</span></div>'
      + '<span class="badge badge-' + t.status + '">' + t.status + '</span>'
      + '</div>'
      + '<div class="ticket-msg">' + esc(t.message) + '</div>'
      + opened
      + '<div class="ticket-meta">Submitted ' + new Date(t.createdAt).toLocaleString() + '</div>'
      + '<div class="ticket-actions">' + actions.join('') + '</div>'
      + '</div>';
  }).join('');
}

async function setStatus(id, status) {
  try {
    const res = await fetch('/api/support-tickets/' + id + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error('update failed');
    await loadTickets();
  } catch (e) {
    alert('Could not update ticket — please try again.');
  }
}

document.getElementById('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentFilter = btn.dataset.f;
  render();
});

loadTickets();
</script>
</body></html>`;
