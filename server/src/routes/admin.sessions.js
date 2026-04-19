import { Router } from 'express';
import db from '../db.js';
import { config } from '../config.js';
import { recordAudit } from '../services/auditLog.js';
import { archiveSession } from '../services/licenseService.js';
import { isSuperAdmin } from '../middleware/auth.js';

const router = Router();

// GET /api/admin/sessions/:sessionId/proxy-stats — per-profile SOCKS5 byte
// counters reported by the bot over the session's lifetime. Ordered by
// most bytes (sent+recv) so the highest-traffic proxies show first.
router.get('/:sessionId/proxy-stats', async (req, res) => {
  const { sessionId } = req.params;
  const rows = await db('bot_proxy_stats')
    .where('session_id', sessionId)
    .orderByRaw('(bytes_sent + bytes_recv) desc')
    .select('profile_name', 'host', 'port',
            'bytes_sent', 'bytes_recv',
            'sockets_active', 'sockets_total',
            'recorded_at');
  res.json({ data: rows });
});

// DELETE /api/admin/sessions/:sessionId — kill (archive) a bot session
router.delete('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = await db('bot_sessions').where('session_id', sessionId).where('active', true).first();
  if (!session) return res.status(404).json({ error: 'Session not found' });

  await archiveSession(db, sessionId, 'admin_kill');
  await recordAudit(db, req, {
    action: 'session.kill', subjectType: 'session', subjectId: sessionId,
    oldValues: { license_key: session.license_key, hwid: session.hwid },
  });
  res.json({ ok: true });
});

// GET /api/admin/sessions — paginated list with license + user info
router.get('/', async (req, res) => {
  const page   = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit  = 50;
  const offset = (page - 1) * limit;
  const cutoff = Math.floor(Date.now() / 1000) - config.bot.sessionTimeoutSec;

  // Filter: ?status=active (default) or ?status=archived or ?status=all
  const statusFilter = req.query.status || 'active';

  // IP columns are only exposed to super-admins. Plain admins see all
  // other session metadata but not per-session IPs.
  const canSeeIp = isSuperAdmin(req);
  const selectCols = [
    'bot_sessions.session_id',
    'bot_sessions.license_key',
    'bot_sessions.hwid',
    'bot_sessions.started_at',
    'bot_sessions.last_heartbeat',
    'bot_sessions.active',
    'bot_sessions.ended_at',
    'bot_sessions.end_reason',
    'bot_sessions.stats_json',
    // Game-server fields (not super-admin-gated — a game-server endpoint
    // is a public address, unlike the admin-client ip_address below).
    'bot_sessions.game_server_ip',
    'bot_sessions.game_server_port',
    'bot_sessions.game_server_variant',
    'users.name as user_name',
    'users.email as user_email',
  ];
  if (canSeeIp) {
    selectCols.push('bot_sessions.ip_address',
                    'bot_sessions.last_ip_address');
  }

  let query = db('bot_sessions')
    .join('licenses', 'bot_sessions.license_key', 'licenses.license_key')
    .leftJoin('users', 'licenses.user_id', 'users.id')
    .select(...selectCols);

  if (statusFilter === 'active')   query = query.where('bot_sessions.active', true);
  if (statusFilter === 'archived') query = query.where('bot_sessions.active', false);

  let countQuery = db('bot_sessions');
  if (statusFilter === 'active')   countQuery = countQuery.where('active', true);
  if (statusFilter === 'archived') countQuery = countQuery.where('active', false);

  const [rows, countResult] = await Promise.all([
    query.orderBy('bot_sessions.last_heartbeat', 'desc').limit(limit).offset(offset),
    countQuery.count('* as total').first(),
  ]);

  const now = Math.floor(Date.now() / 1000);
  for (const row of rows) {
    row.idle_seconds = now - row.last_heartbeat;
    row.is_alive = row.active && row.last_heartbeat > cutoff;
    try { row.stats = row.stats_json ? JSON.parse(row.stats_json) : null; } catch { row.stats = null; }
    delete row.stats_json;
  }

  res.json({
    data: rows,
    page,
    totalPages: Math.ceil(Number(countResult.total) / limit),
    total:      Number(countResult.total),
  });
});

export default router;
