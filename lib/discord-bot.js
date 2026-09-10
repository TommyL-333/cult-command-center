/**
 * lib/discord-bot.js — one bot, listening across every server it's invited
 * to, turns an @Support role mention into a support ticket.
 *
 * Why one bot instead of one-per-channel/one-per-server: a Discord message
 * event already carries which guild and channel it came from
 * (message.guild.id / message.channel.id / message.channel.name) — that's
 * exactly what we need to set the ticket "topic" to the channel name, so
 * staff aren't digging through channels to find context. Running separate
 * bot processes per channel would only multiply tokens/hosting for zero
 * benefit; per-guild config (which role triggers a ticket) is handled by
 * db/discord.js's discord_servers table instead.
 *
 * This client runs in-process with dashboard-server.js (same long-lived
 * Railway service, not a separate one) so the reply path below can call
 * client.channels.fetch(...).send() directly with no internal HTTP hop.
 *
 * Required setup in the Discord Developer Portal (can't be done from code):
 *   - Bot > Privileged Gateway Intents: enable "Message Content Intent"
 *     (and "Server Members Intent" if you later gate on member roles there).
 *     This is a portal-only toggle — needs login access to whichever
 *     account/team owns the application, not just its token.
 *   - Invite the bot to each server with permissions: View Channels, Send
 *     Messages, Create Public Threads, Send Messages in Threads, Add
 *     Reactions, Read Message History.
 *   - Set DISCORD_SUPPORT_BOT_TOKEN, OR reuse DISCORD_BOT_TOKEN (already
 *     used for role-assignment elsewhere) if it's the same application —
 *     see BOT_TOKEN below. A bot can hold a live gateway connection and
 *     serve REST calls on the same token at once, so reusing it is safe;
 *     DISCORD_SUPPORT_BOT_TOKEN exists purely so this feature isn't
 *     blocked on recovering portal access to whatever app DISCORD_BOT_TOKEN
 *     already belongs to — point it at a second, dedicated application if
 *     that's easier than tracking down the original owner.
 *   - Set DISCORD_SUPPORT_ROLE_ID to the @Support role's ID for the main
 *     guild (seeded into discord_servers by db/discord.js), or set
 *     support_role_id directly on additional discord_servers rows for
 *     other guilds.
 */

'use strict';

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { getServerByGuildId } = require('../db/discord');
const { queries } = require('../db/support-tickets');

// DISCORD_SUPPORT_BOT_TOKEN takes priority when set (a second, dedicated
// application) and falls back to the existing DISCORD_BOT_TOKEN otherwise
// (reusing the app that already does role-assignment) — either is fine,
// see the module comment above.
const BOT_TOKEN = process.env.DISCORD_SUPPORT_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;

let client = null;

function truncate(str, max) {
  const s = String(str || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function init() {
  if (!BOT_TOKEN) {
    console.log('[discord-bot] Neither DISCORD_SUPPORT_BOT_TOKEN nor DISCORD_BOT_TOKEN is set — support-mention listener disabled.');
    return null;
  }
  if (client) return client;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once('ready', () => {
    console.log(`[discord-bot] logged in as ${client.user.tag}, watching ${client.guilds.cache.size} guild(s)`);
  });

  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot || !message.guild) return;

      const serverConfig = getServerByGuildId(message.guild.id);
      const supportRoleId = (serverConfig && serverConfig.support_role_id) || process.env.DISCORD_SUPPORT_ROLE_ID;
      if (!supportRoleId) return; // this guild has no @Support role configured

      if (!message.mentions.roles.has(supportRoleId)) return;

      const channelName = 'name' in message.channel ? message.channel.name : 'direct-message';

      // Thread the ticket onto the triggering message — keeps the whole
      // back-and-forth scoped, and the thread ID is the reply target.
      let thread = null;
      try {
        if (message.channel.threads && typeof message.startThread === 'function') {
          thread = await message.startThread({
            name: truncate(`Support: ${channelName} — ${message.author.username}`, 100),
            autoArchiveDuration: 1440,
          });
        }
      } catch (e) {
        console.error('[discord-bot] startThread failed, falling back to channel replies:', e.message);
      }

      try { await message.react('👀'); } catch (_) { /* missing perms — non-fatal */ }

      const ackText = "Got it — this has been sent to the support team. They'll reply here.";
      try {
        if (thread) await thread.send(ackText);
        else await message.reply(ackText);
      } catch (e) {
        console.error('[discord-bot] ack send failed:', e.message);
      }

      // cleanContent resolves <@&roleId>/<@userId>/<#channelId> into readable
      // @RoleName/@username/#channel-name — raw message.content would store
      // the literal Discord markup, which is what staff would otherwise see
      // on the webapp instead of legible text.
      queries.insertDiscordTicket.run(
        truncate(message.cleanContent, 4000) || '(no text — see attachment/embed)',
        message.guild.id,
        message.channel.id,
        channelName,
        thread ? thread.id : message.channel.id, // no thread perms? reply target falls back to the channel itself
        message.url,
        message.author.id,
        message.author.tag
      );
    } catch (e) {
      console.error('[discord-bot] messageCreate handler failed:', e.message);
    }
  });

  client.login(BOT_TOKEN).catch((e) => {
    console.error('[discord-bot] login failed:', e.message);
  });

  return client;
}

/**
 * Post a staff reply back to the ticket's originating thread (or channel,
 * if the bot couldn't open a thread). Throws if the channel/thread can no
 * longer be reached (e.g. deleted) — caller decides how to surface that.
 */
async function sendReply(ticket, text) {
  if (!client) throw new Error('Discord bot is not running (no DISCORD_BOT_TOKEN?)');
  if (!ticket.discord_thread_id) throw new Error('Ticket has no Discord thread to reply into');

  const channel = await client.channels.fetch(ticket.discord_thread_id);
  if (!channel) throw new Error('Discord channel/thread not found');

  const mention = ticket.discord_author_id ? `<@${ticket.discord_author_id}> ` : '';
  await channel.send(`${mention}${text}`);
}

module.exports = { init, sendReply };
