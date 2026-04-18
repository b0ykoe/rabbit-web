import { Router } from 'express';
import db from '../db.js';
import { config } from '../config.js';
import { archiveSession } from '../services/licenseService.js';

const router = Router();

// DELETE /api/portal/keys/:sessionId — user kills their own session
router.delete('/:sessionId', async (req, res) => {
  const userId = req.session.user.id;
  const { sessionId } = req.params;

  // Verify session belongs to one of the user's keys
  const session = await db('bot_sessions')
    .where('bot_sessions.session_id', sessionId)
    .join('licenses', 'bot_sessions.license_key', 'licenses.license_key')
    .where('licenses.user_id', userId)
    .select('bot_sessions.session_id')
    .first();

  if (!session) return res.status(404).json({ error: 'Session not found' });

  await archiveSession(db, sessionId, 'user_kill');
  res.json({ ok: true });
});

// GET /api/portal/keys — user's keys with all sessions
router.get('/', async (req, res) => {
  const userId = req.session.user.id;
  const cutoff = Math.floor(Date.now() / 1000) - config.bot.sessionTimeoutSec;

  const licenses = await db('licenses')
    .where('user_id', userId)
    .select('license_key', 'max_sessions', 'active', 'note', 'expires_at', 'bound_hwid');

  const keys = licenses.map(l => l.license_key);
  let activeSessions = [];
  let archivedSessions = [];
  if (keys.length) {
    activeSessions = await db('bot_sessions')
      .whereIn('license_key', keys)
      .where('active', true)
      .orderBy('last_heartbeat', 'desc')
      .select('session_id', 'license_key', 'hwid', 'started_at', 'last_heartbeat', 'stats_json');

    archivedSessions = await db('bot_sessions')
      .whereIn('license_key', keys)
      .where('active', false)
      .orderBy('ended_at', 'desc')
      .limit(20)
      .select('session_id', 'license_key', 'hwid', 'started_at', 'last_heartbeat', 'ended_at', 'end_reason', 'stats_json');
  }

  // Parse stats_json for all sessions
  const parseStats = (s) => {
    try { s.stats = s.stats_json ? JSON.parse(s.stats_json) : null; } catch { s.stats = null; }
    delete s.stats_json;
  };
  activeSessions.forEach(parseStats);
  archivedSessions.forEach(parseStats);

  for (const lic of licenses) {
    lic.liveSessions     = activeSessions.filter(s => s.license_key === lic.license_key && s.last_heartbeat > cutoff);
    lic.staleSessions    = activeSessions.filter(s => s.license_key === lic.license_key && s.last_heartbeat <= cutoff);
    lic.archivedSessions = archivedSessions.filter(s => s.license_key === lic.license_key);
  }

  // Bought but unredeemed keys — include banked duration_days so the UI
  // can show "30 days banked, starts on redeem" instead of "expires never".
  const boughtKeys = await db('licenses')
    .where({ purchased_by: userId, active: true })
    .whereNull('user_id')
    .select('license_key', 'expires_at', 'duration_days', 'max_sessions', 'note', 'created_at');

  res.json({ licenses, boughtKeys });
});

export default router;
