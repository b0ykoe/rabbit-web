import { Router } from 'express';
import db from '../db.js';
import { config } from '../config.js';

const router = Router();

// GET /api/portal/sessions — user's session history with aggregated stats
router.get('/', async (req, res) => {
  const userId = req.session.user.id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const status = req.query.status || 'all'; // active | archived | all
  const perPage = 25;

  // Get user's license keys
  const userKeys = await db('licenses')
    .where('user_id', userId)
    .pluck('license_key');

  if (userKeys.length === 0) {
    return res.json({ data: [], aggregates: { kills: 0, xp_earned: 0, items_looted: 0, deaths: 0, sessions: 0, runtime_ms: 0 }, total: 0, totalPages: 0 });
  }

  // Build query
  let query = db('bot_sessions').whereIn('license_key', userKeys);
  if (status === 'active') query = query.where('active', true);
  else if (status === 'archived') query = query.where('active', false);

  // Count
  const [{ count }] = await query.clone().count('* as count');
  const total = Number(count);
  const totalPages = Math.ceil(total / perPage);

  // Fetch page
  const sessions = await query.clone()
    .orderBy('started_at', 'desc')
    .offset((page - 1) * perPage)
    .limit(perPage)
    .select('session_id', 'license_key', 'hwid', 'started_at', 'last_heartbeat', 'ended_at', 'end_reason', 'active', 'stats_json');

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - config.bot.sessionTimeoutSec;

  sessions.forEach((s) => {
    try { s.stats = s.stats_json ? JSON.parse(s.stats_json) : null; } catch { s.stats = null; }
    delete s.stats_json;
    s.is_alive = s.active && s.last_heartbeat > cutoff;
    s.idle_seconds = s.active ? now - s.last_heartbeat : null;
  });

  // Aggregated stats across all sessions for this user
  const allSessions = await db('bot_sessions')
    .whereIn('license_key', userKeys)
    .select('stats_json', 'started_at', 'ended_at', 'active');

  const aggregates = { kills: 0, xp_earned: 0, items_looted: 0, deaths: 0, sessions: allSessions.length, runtime_ms: 0 };
  for (const s of allSessions) {
    try {
      const stats = s.stats_json ? JSON.parse(s.stats_json) : null;
      if (stats) {
        aggregates.kills += stats.kills || 0;
        aggregates.xp_earned += stats.xp_earned || 0;
        aggregates.items_looted += stats.items_looted || 0;
        aggregates.deaths += stats.deaths || 0;
        aggregates.runtime_ms += stats.runtime_ms || 0;
      }
    } catch { /* skip */ }
  }

  res.json({ data: sessions, aggregates, total, totalPages });
});

export default router;
