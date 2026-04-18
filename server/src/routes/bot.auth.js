import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { config } from '../config.js';
import { signToken, parseTokenPayload, verifyToken, generateJti } from '../crypto/ed25519.js';
import { hasAvailableSlot, archiveSession, archiveOldestSessionByKey } from '../services/licenseService.js';
import { validateBotUserToken } from '../middleware/botToken.js';
import { recordAudit } from '../services/auditLog.js';
import { isJtiBlocked, isTokenVersionCurrent } from '../services/tokenSecurity.js';
import { validate, botLoginSchema, botAuthStartSchema, botHeartbeatSchema } from '../validation/schemas.js';

// Full feature-flag map used when the user is a super-admin — every key
// the bot understands set to `true`. Source of truth is still the bot
// struct in Bot/inject/feature_flags.h; keep this in sync if new flags
// are added there.
const ALL_FEATURES_TRUE = Object.freeze({
  // User features
  training: true, skills: true, monsters: true, statistics: true,
  combo: true, options: true, hwid_spoof: true,
  inventory: true, buffs: true, consumables: true,
  // Dev master + per-module
  dev: true, dev_movement: true, dev_entities: true, dev_drops: true,
  dev_skills: true, dev_advanced: true, dev_blacklist: true,
  dev_obstacles: true, dev_npc: true, dev_combo: true,
  dev_terrain: true, dev_debug: true, dev_chat: true,
  dev_inventory: true, dev_buffs: true, dev_anticheat: true,
  dev_packets: true,
});

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
    // W-6: audit every failed login so brute-force campaigns are visible.
    await recordAudit(db, req, {
      action: 'auth.failed_login',
      subjectType: 'user',
      subjectId: user?.id || null,
      newValues: { email, reason: user ? 'bad_password' : 'unknown_email' },
    });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  await db('users').where('id', user.id).update({ last_login_at: db.fn.now() });

  const now = Math.floor(Date.now() / 1000);
  const userToken = await signToken({
    user_id: user.id,
    type:    'user',
    jti:     generateJti(),            // W-1: per-token id for revocation
    tvr:     user.token_version || 1,  // W-2: bulk-revocation version
    exp:     now + 3600,
    iat:     now,
    ver:     1,
  }, config.bot.ed25519PrivateKey);

  const channels = user.allowed_channels ? JSON.parse(user.allowed_channels) : ['release'];
  const licenses = await loadUserLicenses(user.id);

  const isSuperAdmin = user.role === 'super_admin';
  // Super-admins see every feature; plain users/admins see what their
  // feature_flags JSON says. `options` is always on regardless.
  const featureFlags = isSuperAdmin
    ? { ...ALL_FEATURES_TRUE }
    : (user.feature_flags ? JSON.parse(user.feature_flags) : {});

  res.json({
    user_token: userToken,
    user: {
      id:               user.id,
      name:             user.name,
      email:            user.email,
      allowed_channels: channels,
      credits:          user.credits || 0,
      feature_flags:    featureFlags,
      is_super_admin:   isSuperAdmin,
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
    // W-6: surface key-enumeration attempts.
    await recordAudit(db, req, {
      action: 'auth.invalid_key',
      subjectType: 'license',
      subjectId: null,
      newValues: { license_key: key, session_id },
    });
    return res.status(401).json({ error: 'Invalid or revoked key' });
  }

  // Check expiry
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.status(403).json({ error: 'License has expired' });
  }

  // HWID binding — if key has a bound HWID, reject mismatches
  if (hwid && license.bound_hwid && license.bound_hwid !== hwid) {
    // W-6: HWID mismatch is a signal of license sharing. Always audit.
    await recordAudit(db, req, {
      action: 'auth.hwid_mismatch',
      subjectType: 'license',
      subjectId: license.id || null,
      oldValues: { bound_hwid: license.bound_hwid },
      newValues: { attempted_hwid: hwid, license_key: key, session_id },
    });
    return res.status(403).json({ error: 'HWID mismatch. Reset HWID to use a different machine.' });
  }

  // Look up the key's owner up front — needed for super-admin bypass
  // AND feature-flag resolution below.
  const user = license.user_id
    ? await db('users').where('id', license.user_id)
        .select('id', 'role', 'feature_flags').first()
    : null;
  const isSuperAdmin = user?.role === 'super_admin';

  // Concurrent-session enforcement. Super-admins skip the check so they
  // can run multi-instance tests without provisioning a separate license.
  if (!isSuperAdmin && !(await hasAvailableSlot(db, key, license.max_sessions))) {
    // Default policy: kill the oldest active session on overflow so new
    // logins always succeed (user intent is usually "move to this PC").
    // Flipping this to a hard 409 is a one-line change here.
    const killed = await archiveOldestSessionByKey(db, key, 'session_overflow');
    if (killed > 0) {
      await recordAudit(db, req, {
        action: 'session.overflow_kill',
        subjectType: 'license',
        subjectId: license.id || null,
        newValues: { license_key: key, reason: 'session_overflow' },
      });
    } else {
      return res.status(403).json({ error: 'Max concurrent sessions reached' });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const ip  = req.ip || null;

  // Bind HWID on first use
  if (hwid && !license.bound_hwid) {
    await db('licenses').where('license_key', key).update({ bound_hwid: hwid });
  }

  // Upsert bot session (captures ip_address + last_ip_address)
  const sessionData = {
    license_key:     key,
    hwid:            hwid || null,
    started_at:      now,
    last_heartbeat:  now,
    ip_address:      ip,
    last_ip_address: ip,
  };

  const existing = await db('bot_sessions').where('session_id', session_id).first();
  if (existing) {
    await db('bot_sessions').where('session_id', session_id).update(sessionData);
  } else {
    await db('bot_sessions').insert({ session_id, ...sessionData });
  }

  // Sign Ed25519 token. The session token carries both the license's
  // token_version (tvr) — so revoking a license invalidates all sessions
  // for it — and a jti so individual tokens can be surgically blocklisted.
  const payload = {
    key,
    session_id,
    jti: generateJti(),
    tvr: license.token_version || 1,
    exp: now + 3600,
    iat: now,
    ver: 1,
  };

  const token = await signToken(payload, config.bot.ed25519PrivateKey);

  // Feature flags — super-admin sees everything; everyone else gets
  // their persisted per-user JSON.
  const featureFlags = isSuperAdmin
    ? { ...ALL_FEATURES_TRUE }
    : (user?.feature_flags ? JSON.parse(user.feature_flags) : {});

  res.json({ token, feature_flags: featureFlags });
});

// POST /api/bot/auth/heartbeat — update last_heartbeat + optional token refresh
//
// C-2: the token is MANDATORY and MUST be verified. We reject if:
//   - signature fails (Ed25519)
//   - jti is blocklisted (W-1)
//   - tvr is older than license.token_version (W-2)
//   - payload.session_id ≠ body.session_id (session hijack prevention)
//   - payload.key ≠ session.license_key (cross-session token reuse)
router.post('/heartbeat', validate(botHeartbeatSchema), async (req, res) => {
  const { session_id, token, stats } = req.validated;

  if (!token) {
    return res.status(401).json({ error: 'Missing session token' });
  }

  const verified = await verifyToken(token, config.bot.ed25519PublicKey);
  if (!verified) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const { payload: tp } = verified;

  if (tp.session_id !== session_id) {
    return res.status(401).json({ error: 'Session/token mismatch' });
  }

  if (tp.jti && await isJtiBlocked(db, tp.jti)) {
    return res.status(401).json({ error: 'Token revoked' });
  }

  const session = await db('bot_sessions').where({ session_id, active: true }).first();
  if (!session) {
    return res.status(401).json({ error: 'Session not found' });
  }

  // Token must belong to THIS session's license.
  if (tp.key !== session.license_key) {
    return res.status(401).json({ error: 'Session/token license mismatch' });
  }

  if (!(await isTokenVersionCurrent(db, 'license', tp.key, tp.tvr))) {
    return res.status(401).json({ error: 'Token version outdated' });
  }

  const now = Math.floor(Date.now() / 1000);
  const ip  = req.ip || null;
  const updateData = { last_heartbeat: now, last_ip_address: ip };
  if (stats) {
    updateData.stats_json = JSON.stringify(stats);
  }
  await db('bot_sessions').where('session_id', session_id).update(updateData);

  // IP drift detector — any time the heartbeat comes from a different IP
  // than we saw last tick, record an audit event. Only fires on actual
  // change (not on first heartbeat where last_ip_address was just set).
  if (ip && session.last_ip_address && ip !== session.last_ip_address) {
    await recordAudit(db, req, {
      action: 'session.ip_changed',
      subjectType: 'bot_session',
      subjectId: null,
      oldValues: { ip_address: session.last_ip_address },
      newValues: { ip_address: ip, session_id, license_key: session.license_key },
    });
  }

  // Token refresh: if current token expires within 5 minutes, issue a new
  // one. We already signature-verified `tp` above, so its exp can be
  // trusted (no more unsigned parseTokenPayload path).
  const result = { ok: true };
  if (tp.exp && (tp.exp - now) < 300) {
    const license = await db('licenses').where('license_key', session.license_key).first();
    const newPayload = {
      key:        session.license_key,
      session_id,
      jti:        generateJti(),
      tvr:        license?.token_version || 1,
      exp:        now + 3600,
      iat:        now,
      ver:        1,
    };
    result.token = await signToken(newPayload, config.bot.ed25519PrivateKey);
  }

  res.json(result);
});

// POST /api/bot/auth/end — archive session (truly idempotent).
// Requires a signed session token so one client can't end another
// client's session by guessing its id. Unknown or already-ended
// sessions return 410 Gone so callers can distinguish.
router.post('/end', async (req, res) => {
  const sid       = req.body?.session_id;
  const tokenB64  = req.body?.token;
  if (!sid || !tokenB64) {
    return res.status(400).json({ error: 'Missing session_id or token' });
  }

  const verified = await verifyToken(tokenB64, config.bot.ed25519PublicKey);
  if (!verified || verified.payload.session_id !== sid) {
    return res.status(401).json({ error: 'Invalid token for session' });
  }

  const session = await db('bot_sessions').where('session_id', sid).first();
  if (!session) {
    return res.status(410).json({ error: 'Session not found' });
  }
  if (!session.active) {
    return res.status(200).json({ ok: true, already_ended: true });
  }

  await archiveSession(db, sid, 'user_end');
  res.json({ ok: true });
});

export default router;
