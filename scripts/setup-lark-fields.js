// setup-lark-fields.js
// Run once to add the new Offer Tiers field to Templates table and
// the offer-specific fields to the Clients table.
// Usage: LARK_APP_ID=... LARK_APP_SECRET=... node scripts/setup-lark-fields.js
const axios = require('axios');

const APP  = process.env.OPS_ENGINE_BASE || 'EsfBbIqfkauKozsxMHMuilDztod';
const T    = { Clients: 'tblgM1L7myeAfYQm', Templates: 'tbl3M7PFNZGKZW5J' };
const BASE = 'https://open.larksuite.com/open-apis';

async function tenantToken() {
  const r = await axios.post(`${BASE}/auth/v3/tenant_access_token/internal`, {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  return r.data.tenant_access_token;
}

function H(t) { return { headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } }; }

async function listFields(t, table) {
  const r = await axios.get(`${BASE}/bitable/v1/apps/${APP}/tables/${table}/fields`, H(t));
  return r.data.data?.items || [];
}

async function addField(t, table, body, label) {
  try {
    const r = await axios.post(`${BASE}/bitable/v1/apps/${APP}/tables/${table}/fields`, body, H(t));
    const name = r.data.data?.field?.field_name || body.field_name;
    console.log(`  ✅  ${label || name}`);
    return r.data.data?.field;
  } catch (e) {
    const msg = JSON.stringify(e.response?.data || e.message);
    console.log(`  ⚠️  ${label || body.field_name}: ${msg.slice(0, 120)}`);
  }
}

async function run() {
  if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) {
    console.error('Set LARK_APP_ID and LARK_APP_SECRET env vars first.');
    process.exit(1);
  }
  const t = await tenantToken();

  // ── Existing field names (so we skip duplicates) ──────────────────────────
  const clientFields   = new Set((await listFields(t, T.Clients)).map(f => f.field_name));
  const templateFields = new Set((await listFields(t, T.Templates)).map(f => f.field_name));

  console.log('\n── Templates table ──────────────────────────────────────────');

  if (!templateFields.has('Offer Tiers')) {
    await addField(t, T.Templates, {
      field_name: 'Offer Tiers',
      type: 4, // multi-select
      property: {
        options: [
          { name: 'Foundation' },
          { name: 'Growth Partner' },
          { name: 'Scale' },
          { name: 'Creator Network' },
        ],
      },
    }, 'Offer Tiers (multi-select)');
  } else {
    console.log('  — Offer Tiers already exists');
  }

  console.log('\n── Clients table ────────────────────────────────────────────');

  const clientsToAdd = [
    // single select
    {
      field_name: 'Offer Tier',
      type: 3, // single select
      property: { options: [
        { name: 'Foundation' },
        { name: 'Growth Partner' },
        { name: 'Scale' },
        { name: 'Creator Network' },
      ]},
    },
    // numbers
    { field_name: 'Open Commission %',      type: 2 },
    { field_name: 'Creator Commission %',   type: 2 },
    { field_name: 'CC Cut %',               type: 2 },
    { field_name: 'Cohort 1 Budget',        type: 2 },
    { field_name: 'Cohort 2 Creator Count', type: 2 },
    { field_name: 'Cohort 2 Total Cost',    type: 2 },
    { field_name: 'Ads Budget',             type: 2 },
    { field_name: 'Addon Monthly Total',    type: 2 },
    // text
    { field_name: 'TikTok Shop Code',          type: 1 },
    { field_name: 'Account Slot Type',         type: 1 },
    { field_name: 'ROAS Target',               type: 1 },
    // Promotional strategy
    { field_name: 'Promo Code',                type: 1 },
    { field_name: 'Promo Discount',            type: 1 },
    { field_name: 'BMSM Strategy',             type: 1 },
    { field_name: 'GWP Strategy',              type: 1 },
    { field_name: 'Follower Coupon',           type: 1 },
    { field_name: 'Review Coupon',             type: 1 },
    { field_name: 'Creator Exclusive Price',   type: 1 },
  ];

  for (const spec of clientsToAdd) {
    if (clientFields.has(spec.field_name)) {
      console.log(`  — ${spec.field_name} already exists`);
    } else {
      await addField(t, T.Clients, spec);
    }
  }

  console.log('\nDone.');
}

run().catch(e => { console.error(e.message); process.exit(1); });
