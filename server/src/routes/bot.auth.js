import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { config } from '../config.js';
import { signToken, parseTokenPayload } from '../crypto/ed25519.js';
import { hasAvailableSlot, archiveSession } from '../services/licenseService.js';
import { validateBotUserToken } from '../middleware/botToken.js';
import { validate, botLoginSchema, botAuthStartSchema, botHeartbeatSchema } from '../validation/schemas.js';

const router = Router();

// ── Helper: load user's licenses with live sessions ─────────────────────────
async function loadUserLicenses(userId) {
  const cutoff = Math.floor(Date.now() / 1000) - config.bot.sessionTimeoutSec;

  const licenses = await db('licenses')
    .where('user_id', userId)
    .select('license_key', 'max_sessions', 'active', 'note', 'expires_at', 'bound_hwid');

  const keys = licenses.map(l => l.license_key);
  let allSessions = [];
  if (keys.length) {
    allSessions = await db('bot_sessions')
      .whereIn('license_key', keys)
      .where('active', true)
      .where('last_heartbeat', '>', cutoff)
      .orderBy('last_heartbeat', 'desc')
      .select('session_id', 'license_key', 'hwid', 'started_at', 'last_heartbeat');
  }

  return licenses.map(lic => ({
    ...lic,
    live_sessions: allSessions.filter(s => s.license_key === lic.license_key),
  }));
}

// POST /api/bot/login — authenticate user, return user token + keys
router.post('/login', validate(botLoginSchema), async (req, res) => {
  const { email, password } = req.validated;

  const user = await db('users').where('email', email).first();
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  await db('users').where('id', user.id).update({ last_login_at: db.fn.now() });

  const now = Math.floor(Date.now() / 1000);
  const userToken = await signToken({
    user_id: user.id,
    type:    'user',
    exp:     now + 3600,
    iat:     now,
    ver:     1,
  }, config.bot.ed25519PrivateKey);

  const channels = user.allowed_channels ? JSON.parse(user.allowed_channels) : ['release'];
  const licenses = await loadUserLicenses(user.id);

  const featureFlags = user.feature_flags ? JSON.parse(user.feature_flags) : {};

  res.json({
    user_token: userToken,
    user: {
      id:               user.id,
      name:             user.name,
      email:            user.email,
      allowed_channels: channels,
      credits:          user.credits || 0,
      feature_flags:    featureFlags,
    },
    licenses,
  });
});

// GET /api/bot/keys — refresh user's keys with live sessions (requires user token)
router.get('/keys', validateBotUserToken, async (req, res) => {
  const licenses = await loadUserLicenses(req.botUser.id);
  res.json({ licenses });
});

// POST /api/bot/auth/redeem — claim an unassigned key (requires user token)
router.post('/redeem', validateBotUserToken, async (req, res) => {
  const key = req.body?.key;
  if (!key) return res.status(400).json({ error: 'Missing key' });

  const license = await db('licenses').where('license_key', key).first();
  if (!license)        return res.status(404).json({ error: 'Key not found' });
  if (!license.active) return res.status(422).json({ error: 'Key has been revoked' });
  if (license.user_id) return res.status(422).json({ error: 'Key is already claimed' });
  if (license.expires_at && new Date(license.expires_at) < new Date())
    return res.status(422).json({ error: 'Key has expired' });

  await db('licenses').where('license_key', key).update({ user_id: req.botUser.id });
  res.json({ ok: true, license_key: key });
});

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

  // Include feature flags for the DLL
  let featureFlags = {};
  if (license.user_id) {
    const user = await db('users').where('id', license.user_id).select('feature_flags').first();
    if (user?.feature_flags) featureFlags = JSON.parse(user.feature_flags);
  }

  res.json({ token, feature_flags: featureFlags });
});

// POST /api/bot/auth/heartbeat — update last_heartbeat + optional token refresh
router.post('/heartbeat', validate(botHeartbeatSchema), async (req, res) => {
  const { session_id, token, stats } = req.validated;
  const session = await db('bot_sessions').where({ session_id, active: true }).first();
  if (!session) {
    return res.status(401).json({ error: 'Session not found' });
  }

  const now = Math.floor(Date.now() / 1000);
  const updateData = { last_heartbeat: now };
  if (stats) {
    updateData.stats_json = JSON.stringify(stats);
  }
  await db('bot_sessions').where('session_id', session_id).update(updateData);

  // Token refresh: if token provided and expires within 5 minutes, issue a new one
  const result = { ok: true };
  if (token) {
    const payload = parseTokenPayload(token);
    if (payload?.exp && (payload.exp - now) < 300) {
      const newPayload = {
        key:        session.license_key,
        session_id,
        exp:        now + 3600,
        iat:        now,
        ver:        1,
      };
      result.token = await signToken(newPayload, config.bot.ed25519PrivateKey);
    }
  }

  res.json(result);
});

// POST /api/bot/auth/end — archive session (idempotent)
router.post('/end', async (req, res) => {
  const sid = req.body?.session_id;
  if (sid) {
    await archiveSession(db, sid, 'user_end');
  }
  res.json({ ok: true });
});

export default router;
