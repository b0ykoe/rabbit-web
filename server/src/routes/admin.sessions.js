import { Router } from 'express';
import db from '../db.js';

const router = Router();

// GET /api/admin/sessions — paginated list with license + user info
router.get('/', async (req, res) => {
  const page   = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit  = 50;
  const offset = (page - 1) * limit;
  const cutoff = Math.floor(Date.now() / 1000) - 90;

  const [rows, countResult] = await Promise.all([
    db('bot_sessions')
      .join('licenses', 'bot_sessions.license_key', 'licenses.license_key')
      .leftJoin('users', 'licenses.user_id', 'users.id')
      .select(
        'bot_sessions.session_id',
        'bot_sessions.license_key',
        'bot_sessions.hwid',
        'bot_sessions.started_at',
        'bot_sessions.last_heartbeat',
        'users.name as user_name',
        'users.email as user_email',
      )
      .orderBy('bot_sessions.last_heartbeat', 'desc')
      .limit(limit)
      .offset(offset),
    db('bot_sessions').count('* as total').first(),
  ]);

  // Annotate each session with idle_seconds and is_alive
  const now = Math.floor(Date.now() / 1000);
  for (const row of rows) {
    row.idle_seconds = now - row.last_heartbeat;
    row.is_alive = row.last_heartbeat > cutoff;
  }

  res.json({
    data: rows,
    page,
    totalPages: Math.ceil(Number(countResult.total) / limit),
    total:      Number(countResult.total),
  });
});

export default router;
