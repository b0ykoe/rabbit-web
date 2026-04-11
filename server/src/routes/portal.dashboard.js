import { Router } from 'express';
import db from '../db.js';

const router = Router();

// GET /api/portal/dashboard — user's overview
router.get('/', async (req, res) => {
  const userId = req.session.user.id;
  const cutoff = Math.floor(Date.now() / 1000) - 90;

  // User's licenses with live session count
  const licenses = await db('licenses')
    .where('user_id', userId)
    .select('license_key', 'max_sessions', 'active', 'note');

  const keys = licenses.map(l => l.license_key);
  let liveSessions = [];
  if (keys.length) {
    liveSessions = await db('bot_sessions')
      .whereIn('license_key', keys)
      .where('last_heartbeat', '>', cutoff)
      .select('session_id', 'license_key', 'started_at', 'last_heartbeat');
  }

  // Attach sessions to licenses
  for (const lic of licenses) {
    lic.sessions = liveSessions.filter(s => s.license_key === lic.license_key);
  }

  // Active DLL release
  const dllRelease = await db('releases').where({ type: 'dll', active: true })
    .select('version', 'sha256', 'created_at')
    .first();

  // Last 5 changelog entries
  const changelog = await db('releases')
    .where('type', 'dll')
    .orderBy('created_at', 'desc')
    .limit(5)
    .select('version', 'changelog', 'active', 'created_at');

  // First active session across all keys (for bot status)
  const activeSession = liveSessions[0] || null;

  res.json({ licenses, dllRelease, changelog, activeSession });
});

export default router;
