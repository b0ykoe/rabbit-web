import { Router } from 'express';
import db from '../db.js';
import { config } from '../config.js';

const router = Router();

// GET /api/admin/dashboard — aggregate stats
router.get('/', async (req, res) => {
  const cutoff = Math.floor(Date.now() / 1000) - config.bot.sessionTimeoutSec;

  const [users, licenses, activeLicenses, liveSessions, releases, recentSessions] = await Promise.all([
    db('users').count('* as count').first(),
    db('licenses').count('* as count').first(),
    db('licenses').where('active', true).count('* as count').first(),
    db('bot_sessions').where('last_heartbeat', '>', cutoff).count('* as count').first(),
    db('releases').where('active', true).select('type', 'version', 'sha256', 'created_at'),
    db('bot_sessions')
      .where('last_heartbeat', '>', cutoff)
      .join('licenses', 'bot_sessions.license_key', 'licenses.license_key')
      .leftJoin('users', 'licenses.user_id', 'users.id')
      .select(
        'bot_sessions.session_id',
        'bot_sessions.license_key',
        'bot_sessions.hwid',
        'bot_sessions.started_at',
        'bot_sessions.last_heartbeat',
        'users.name as user_name',
        'users.email as user_email'
      )
      .orderBy('bot_sessions.last_heartbeat', 'desc')
      .limit(10),
  ]);

  const activeReleases = {};
  for (const r of releases) activeReleases[r.type] = r;

  res.json({
    stats: {
      users:          Number(users.count),
      licenses:       Number(licenses.count),
      activeLicenses: Number(activeLicenses.count),
      liveSessions:   Number(liveSessions.count),
    },
    activeReleases,
    recentSessions,
  });
});

export default router;
