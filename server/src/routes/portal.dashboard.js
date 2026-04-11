import { Router } from 'express';
import db from '../db.js';

const router = Router();

// GET /api/portal/dashboard — user's overview (channel-aware)
router.get('/', async (req, res) => {
  const userId = req.session.user.id;
  const cutoff = Math.floor(Date.now() / 1000) - 90;

  // User's allowed channels
  const userRow = await db('users').where('id', userId).select('allowed_channels').first();
  const channels = userRow?.allowed_channels ? JSON.parse(userRow.allowed_channels) : ['release'];

  // User's licenses with live session count
  const licenses = await db('licenses')
    .where('user_id', userId)
    .select('license_key', 'max_sessions', 'active', 'note', 'expires_at', 'bound_hwid');

  const keys = licenses.map(l => l.license_key);
  let liveSessions = [];
  if (keys.length) {
    liveSessions = await db('bot_sessions')
      .whereIn('license_key', keys)
      .where('last_heartbeat', '>', cutoff)
      .select('session_id', 'license_key', 'hwid', 'started_at', 'last_heartbeat');
  }

  for (const lic of licenses) {
    lic.sessions = liveSessions.filter(s => s.license_key === lic.license_key);
  }

  // Active DLL release (best channel the user has access to)
  const dllRelease = await db('releases')
    .where({ type: 'dll', active: true })
    .whereIn('channel', channels)
    .select('version', 'sha256', 'channel', 'created_at')
    .orderByRaw(`FIELD(channel, 'alpha', 'beta', 'release')`) // prefer release > beta > alpha
    .first();

  // Active loader releases for ALL user's channels (show all downloads)
  const loaderReleases = await db('releases')
    .where({ type: 'loader', active: true })
    .whereIn('channel', channels)
    .select('version', 'channel', 'changelog', 'created_at')
    .orderByRaw(`FIELD(channel, 'release', 'beta', 'alpha')`);

  // Changelogs per type across user's channels
  const [dllChangelog, loaderChangelog] = await Promise.all([
    db('releases').where('type', 'dll').whereIn('channel', channels)
      .orderBy('created_at', 'desc').limit(5)
      .select('version', 'changelog', 'active', 'channel', 'created_at'),
    db('releases').where('type', 'loader').whereIn('channel', channels)
      .orderBy('created_at', 'desc').limit(5)
      .select('version', 'changelog', 'active', 'channel', 'created_at'),
  ]);

  const activeSession = liveSessions[0] || null;

  res.json({ licenses, dllRelease, loaderReleases, dllChangelog, loaderChangelog, activeSession });
});

export default router;
