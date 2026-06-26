// client-chat-sync.js
// On client onboarding, create a per-client Lark group chat "{Client Name} Chat",
// add the core team (Tommy, Hasan, Shayan), and post a welcome message with the
// Client Overview Doc + affiliate link + creator signup link + client portal link.
//
// HONEST: never throws into the caller — every Lark failure is caught and logged.
// Fire-and-forget from runOnboardingPipeline. Requires LARK_APP_ID / LARK_APP_SECRET.
//
// NOTE on member-adding: the Lark bot can only add users it is VISIBLE to (App
// Availability scope in the Lark developer console). If a teammate is outside that
// scope, Lark returns 232043 ("bot is invisible to user ids") / 232024. We degrade
// gracefully: chat is still created + welcome still posted, and we report which IDs
// were unaddable so the visibility setting can be widened. Once the bot is made
// visible to the whole team, member-adding works with ZERO code change.
//
// Contract mirrors ops-engine-sync.js:
//   syncClientChat(formData, meta = {}) -> { ok, chatId, chatCreated, membersAdded, membersUnavailable, reason? }
const axios = require('axios');

const BASE = 'https://open.larksuite.com/open-apis';

// Core team — auto-added to every client chat. Tommy is owner (added at creation).
const TEAM = {
  tommy:  'ou_cd6157679f48e0cea557ebcb1995c462',
  hasan:  'ou_c8f157f2f18a8c4ffe6a20d3971348e1',
  shayan: 'ou_19a69dda7462358e4b3c31e2f157a238',
};
// Members to add post-creation (owner is excluded — already a member as owner).
const ADD_MEMBERS = [TEAM.hasan, TEAM.shayan];

// Public host for creator + client portal links.
const PORTAL = (process.env.PORTAL_BASE_URL || 'https://portal.cultcontent.cc').replace(/\/+$/, '');

async function tenantToken() {
  const r = await axios.post(`${BASE}/auth/v3/tenant_access_token/internal`, {
    app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET,
  });
  return r.data.tenant_access_token;
}
function H(t) { return { headers: { Authorization: `Bearer ${t}` } }; }

function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Find an existing "{name} Chat" the bot owns so we don't create duplicates on re-onboard.
async function findExistingChat(t, chatName) {
  try {
    let pt = '';
    do {
      const r = await axios.get(
        `${BASE}/im/v1/chats?page_size=100${pt ? `&page_token=${pt}` : ''}`, H(t));
      const items = r.data?.data?.items || [];
      const hit = items.find(c => (c.name || '').trim() === chatName.trim());
      if (hit) return hit.chat_id;
      pt = r.data?.data?.page_token || '';
    } while (pt);
  } catch (e) { console.error('[client-chat] find existing error:', e.message); }
  return null;
}

async function createChat(t, chatName) {
  const r = await axios.post(`${BASE}/im/v1/chats?user_id_type=open_id`, {
    name: chatName,
    description: 'Cult Content client workspace — overview, links, and ongoing ops.',
    owner_id: TEAM.tommy,
  }, H(t));
  return r.data?.data?.chat_id;
}

// Add members one at a time so one invisible user doesn't reject the whole batch.
// Returns { added:[...], unavailable:[...] }.
async function addMembers(t, chatId, openIds) {
  const added = [], unavailable = [];
  for (const id of openIds) {
    try {
      await axios.post(
        `${BASE}/im/v1/chats/${chatId}/members?member_id_type=open_id`,
        { id_list: [id] }, H(t));
      added.push(id);
    } catch (e) {
      const code = e.response?.data?.code;
      if (code === 232043 || code === 232024) {
        unavailable.push(id);
        console.error(`[client-chat] member ${id} invisible to bot (code ${code}) — widen App Availability scope`);
      } else {
        console.error(`[client-chat] add member ${id} error:`, e.response?.data?.msg || e.message);
      }
    }
  }
  return { added, unavailable };
}

async function postMessage(t, chatId, text) {
  await axios.post(`${BASE}/im/v1/messages?receive_id_type=chat_id`, {
    receive_id: chatId,
    msg_type: 'text',
    content: JSON.stringify({ text }),
  }, H(t));
}

function buildWelcome(brandName, links) {
  const lines = [`🎉 Welcome to the ${brandName} workspace.`, ''];
  lines.push('This is the home base for everything we run for this brand.', '');
  if (links.overviewDoc)  lines.push(`📄 Client Overview Doc:\n${links.overviewDoc}`, '');
  if (links.affiliate)    lines.push(`🔗 Affiliate link:\n${links.affiliate}`, '');
  if (links.creatorPage)  lines.push(`✨ Creator signup page:\n${links.creatorPage}`, '');
  if (links.clientPortal) lines.push(`📊 Client portal:\n${links.clientPortal}`, '');
  lines.push('', 'Team is in here and Sisyphus is watching this thread — drop anything you need.');
  return lines.join('\n');
}

async function syncClientChat(formData = {}, meta = {}) {
  try {
    const brandName = formData.brandName || meta.brandName;
    if (!brandName) return { ok: false, reason: 'no brand name' };

    const slug = meta.brandSlug || slugify(brandName);
    const chatName = `${brandName} Chat`;

    const links = {
      overviewDoc:  meta.larkDocUrl || null,
      affiliate:    meta.affiliateLink || formData.affiliateLink || null,
      creatorPage:  meta.creatorPageUrl || (slug ? `${PORTAL}/creators/${slug}` : null),
      clientPortal: meta.clientPortalUrl || (slug ? `${PORTAL}/clients` : null),
    };

    const t = await tenantToken();

    // Idempotent: reuse an existing chat of the same name if present.
    let chatId = await findExistingChat(t, chatName);
    let created = false;
    if (!chatId) {
      chatId = await createChat(t, chatName);
      created = true;
    }
    if (!chatId) return { ok: false, reason: 'chat creation failed' };

    // Best-effort team membership (Lark dedupes existing members; invisible users are skipped).
    const { added, unavailable } = await addMembers(t, chatId, ADD_MEMBERS);

    // Only post the welcome on first creation to avoid spamming on re-onboard.
    if (created) {
      await postMessage(t, chatId, buildWelcome(brandName, links));
    }

    console.log(`[client-chat] ${created ? 'created' : 'reused'} "${chatName}" (${chatId}) | added ${added.length}, unavailable ${unavailable.length}`);
    return { ok: true, chatId, chatCreated: created, membersAdded: added, membersUnavailable: unavailable, links };
  } catch (e) {
    console.error('[client-chat] sync error:', e.response?.data || e.message);
    return { ok: false, reason: (e.response?.data?.msg || e.message) };
  }
}

module.exports = {
  syncClientChat,
  _internals: { findExistingChat, createChat, addMembers, postMessage, buildWelcome, slugify, tenantToken, TEAM, ADD_MEMBERS },
};
