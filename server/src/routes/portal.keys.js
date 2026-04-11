import { Router } from 'express';
import db from '../db.js';

const router = Router();

// GET /api/portal/keys — user's keys with all sessions
router.get('/', async (req, res) => {
  const userId = req.session.user.id;
  const cutoff = Math.floor(Date.now() / 1000) - 90;

  const licenses = await db('licenses')
    .where('user_id', userId)
    .select('license_key', 'max_sessions', 'active', 'note');

  const keys = licenses.map(l => l.license_key);
  let allSessions = [];
  if (keys.length) {
    allSessions = await db('bot_sessions')
      .whereIn('license_key', keys)
      .orderBy('last_heartbeat', 'desc')
      .select('session_id', 'license_key', 'started_at', 'last_heartbeat');
  }

  for (const lic of licenses) {
    const sessions = allSessions.filter(s => s.license_key === lic.license_key);
    lic.liveSessions  = sessions.filter(s => s.last_heartbeat > cutoff);
    lic.staleSessions = sessions.filter(s => s.last_heartbeat <= cutoff);
  }

  res.json({ licenses });
});

export default router;
