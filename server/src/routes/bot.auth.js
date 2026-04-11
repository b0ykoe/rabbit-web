import { Router } from 'express';
import db from '../db.js';
import { config } from '../config.js';
import { signToken } from '../crypto/ed25519.js';
import { hasAvailableSlot } from '../services/licenseService.js';
import { validate, botAuthStartSchema, botHeartbeatSchema } from '../validation/schemas.js';

const router = Router();

// POST /api/bot/auth/start — validate key, create session, issue signed token
router.post('/start', validate(botAuthStartSchema), async (req, res) => {
  const { key, session_id, hwid } = req.validated;

  const license = await db('licenses').where({ license_key: key, active: true }).first();
  if (!license) {
    return res.status(401).json({ error: 'Invalid or revoked key' });
  }

  // Check expiry
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.status(403).json({ error: 'License has expired' });
  }

  // HWID binding — if key has a bound HWID, reject mismatches
  if (hwid && license.bound_hwid && license.bound_hwid !== hwid) {
    return res.status(403).json({ error: 'HWID mismatch. Reset HWID to use a different machine.' });
  }

  if (!(await hasAvailableSlot(db, key, license.max_sessions))) {
    return res.status(403).json({ error: 'Max concurrent sessions reached' });
  }

  const now = Math.floor(Date.now() / 1000);

  // Bind HWID on first use
  if (hwid && !license.bound_hwid) {
    await db('licenses').where('license_key', key).update({ bound_hwid: hwid });
  }

  // Upsert bot session
  const sessionData = {
    license_key:    key,
    hwid:           hwid || null,
    started_at:     now,
    last_heartbeat: now,
  };

  const existing = await db('bot_sessions').where('session_id', session_id).first();
  if (existing) {
    await db('bot_sessions').where('session_id', session_id).update(sessionData);
  } else {
    await db('bot_sessions').insert({ session_id, ...sessionData });
  }

  // Sign Ed25519 token
  const payload = {
    key,
    session_id,
    exp: now + 3600,
    iat: now,
    ver: 1,
  };

  const token = await signToken(payload, config.bot.ed25519PrivateKey);
  res.json({ token });
});

// POST /api/bot/auth/heartbeat — update last_heartbeat
router.post('/heartbeat', validate(botHeartbeatSchema), async (req, res) => {
  const { session_id } = req.validated;
  const session = await db('bot_sessions').where('session_id', session_id).first();
  if (!session) {
    return res.status(401).json({ error: 'Session not found' });
  }

  await db('bot_sessions').where('session_id', session_id).update({
    last_heartbeat: Math.floor(Date.now() / 1000),
  });
  res.json({ ok: true });
});

// POST /api/bot/auth/end — delete session (idempotent)
router.post('/end', async (req, res) => {
  const sid = req.body?.session_id;
  if (sid) {
    await db('bot_sessions').where('session_id', sid).del();
  }
  res.json({ ok: true });
});

export default router;
