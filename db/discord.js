/**
 * db/discord.js — multi-server Discord config + per-server join/role state.
 *
 * Today's Discord integration (dashboard-server.js, several call sites) is
 * hardcoded to a single guild via three env vars: DISCORD_BOT_TOKEN,
 * DISCORD_GUILD_ID, DISCORD_CREATOR_ROLE_ID (+ DISCORD_INVITE_URL for the
 * invite link). The confirmed spec calls for creators/brands to have an
 * optional Discord username on their profile that triggers an auto-invite to
 * "a couple of specific servers" — i.e. more than one guild. This table
 * replaces the single env-var guild with a real list; existing behavior is
 * preserved by seeding one row from the current env vars if they're set, so
 * nothing breaks before the invite logic itself is migrated to read from here
 * (that wiring is a later, portal-facing phase — this is schema + helpers only).
 *
 * creator_discord_links intentionally keys on a generic `person_id` (not
 * strictly inner_circle_creators.id) since brand profiles get the optional
 * Discord field too, per spec — not creators only.
 */

const { db } = require('./connection');

db.exec(`
  CREATE TABLE IF NOT EXISTS discord_servers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id         TEXT NOT NULL UNIQUE,
    label            TEXT NOT NULL,
    invite_url       TEXT,
    default_role_id  TEXT,          -- role auto-assigned on join, if any
    active           INTEGER NOT NULL DEFAULT 1,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS creator_discord_links (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id         TEXT NOT NULL,   -- creator or brand id
    person_type       TEXT NOT NULL,   -- 'creator' | 'brand'
    guild_id          TEXT NOT NULL,
    discord_username  TEXT,
    discord_user_id   TEXT,
    invited_at        DATETIME,
    joined_at         DATETIME,
    role_assigned_at  DATETIME,
    UNIQUE(person_id, person_type, guild_id)
  );

  CREATE INDEX IF NOT EXISTS idx_discord_links_person ON creator_discord_links(person_id, person_type);
`);

// Seed one row from the existing single-guild env vars, if configured, so
// nothing regresses before invite logic itself moves to read from this table.
try {
  if (process.env.DISCORD_GUILD_ID) {
    db.prepare(`
      INSERT INTO discord_servers (guild_id, label, invite_url, default_role_id)
      VALUES (@guildId, @label, @inviteUrl, @roleId)
      ON CONFLICT(guild_id) DO UPDATE SET
        invite_url = excluded.invite_url,
        default_role_id = excluded.default_role_id
    `).run({
      guildId: process.env.DISCORD_GUILD_ID,
      label: 'Main (from env)',
      inviteUrl: process.env.DISCORD_INVITE_URL || null,
      roleId: process.env.DISCORD_CREATOR_ROLE_ID || null,
    });
  }
} catch (e) {
  console.error('[db/discord] env-var seed failed:', e.message);
}

const activeServersStmt = db.prepare(`SELECT * FROM discord_servers WHERE active = 1 ORDER BY id`);
const linkStmt = db.prepare(`
  INSERT INTO creator_discord_links (person_id, person_type, guild_id, discord_username, invited_at)
  VALUES (@personId, @personType, @guildId, @discordUsername, CURRENT_TIMESTAMP)
  ON CONFLICT(person_id, person_type, guild_id) DO UPDATE SET
    discord_username = excluded.discord_username,
    invited_at = CURRENT_TIMESTAMP
`);
const markJoinedStmt = db.prepare(`
  UPDATE creator_discord_links SET discord_user_id = ?, joined_at = CURRENT_TIMESTAMP
  WHERE person_id = ? AND person_type = ? AND guild_id = ?
`);
const markRoleAssignedStmt = db.prepare(`
  UPDATE creator_discord_links SET role_assigned_at = CURRENT_TIMESTAMP
  WHERE person_id = ? AND person_type = ? AND guild_id = ?
`);
const linksForPersonStmt = db.prepare(`SELECT * FROM creator_discord_links WHERE person_id = ? AND person_type = ? ORDER BY guild_id`);

/** All servers a new signup with a Discord username should be invited to. */
function getActiveServers() {
  return activeServersStmt.all();
}

/** Record an invite attempt for a person/guild pair (upserts the discord_username). */
function recordInvite(personId, personType, guildId, discordUsername) {
  linkStmt.run({ personId: String(personId), personType, guildId, discordUsername: discordUsername || null });
}

function markJoined(personId, personType, guildId, discordUserId) {
  markJoinedStmt.run(discordUserId || null, String(personId), personType, guildId);
}

function markRoleAssigned(personId, personType, guildId) {
  markRoleAssignedStmt.run(String(personId), personType, guildId);
}

function getLinksForPerson(personId, personType) {
  return linksForPersonStmt.all(String(personId), personType);
}

module.exports = {
  db,
  getActiveServers,
  recordInvite,
  markJoined,
  markRoleAssigned,
  getLinksForPerson,
};
