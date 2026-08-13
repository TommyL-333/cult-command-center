/**
 * routes/messaging.js — universal messaging API (Phase 5 of the platform
 * rebuild). Backed by db/messaging.js. Every route requires an identity
 * (creator, brand, or staff — see middleware/auth.js's requireAnyIdentity)
 * and enforces the caller is actually a participant of the thread they're
 * touching.
 *
 * Mount (before app.use(requireAuth) — creators/brands have no CF Access
 * session):
 *   require('./routes/messaging')(app, { requireAnyIdentity });
 */

const express = require('express');
const msg = require('../db/messaging');

module.exports = function mountMessaging(app, deps = {}) {
  const requireAnyIdentity = deps.requireAnyIdentity;
  if (!requireAnyIdentity) throw new Error('[messaging] requireAnyIdentity dep is required');

  // GET /api/messages/threads — inbox list for the current identity
  app.get('/api/messages/threads', requireAnyIdentity, (req, res) => {
    try {
      const threads = msg.getThreadsForParticipant(req.identity.type, req.identity.id);
      res.json({ ok: true, threads });
    } catch (e) {
      console.error('[messaging] list threads failed:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/messages/threads/:id — thread detail + full message history
  app.get('/api/messages/threads/:id', requireAnyIdentity, (req, res) => {
    try {
      const threadId = Number(req.params.id);
      if (!msg.isParticipant(threadId, req.identity.type, req.identity.id)) {
        return res.status(403).json({ ok: false, error: 'Not a participant of this thread' });
      }
      const thread = msg.getThread(threadId);
      if (!thread) return res.status(404).json({ ok: false, error: 'Thread not found' });
      res.json({ ok: true, thread, messages: msg.getMessages(threadId) });
    } catch (e) {
      console.error('[messaging] get thread failed:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/messages/threads/:id/messages — send a message
  app.post('/api/messages/threads/:id/messages', requireAnyIdentity, express.json(), (req, res) => {
    try {
      const threadId = Number(req.params.id);
      if (!msg.isParticipant(threadId, req.identity.type, req.identity.id)) {
        return res.status(403).json({ ok: false, error: 'Not a participant of this thread' });
      }
      const body = (req.body && req.body.body) || '';
      const messageId = msg.addMessage(threadId, { senderType: req.identity.type, senderId: req.identity.id, body });
      res.json({ ok: true, messageId });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // POST /api/messages/threads/:id/read — mark the thread read for the current identity
  app.post('/api/messages/threads/:id/read', requireAnyIdentity, (req, res) => {
    try {
      const threadId = Number(req.params.id);
      if (!msg.isParticipant(threadId, req.identity.type, req.identity.id)) {
        return res.status(403).json({ ok: false, error: 'Not a participant of this thread' });
      }
      msg.markThreadRead(threadId, req.identity.type, req.identity.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
