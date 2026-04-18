/**
 * Bot token validation middleware.
 * Verifies Ed25519-signed tokens from request body or Authorization header.
 *
 * Beyond signature + expiry (handled by verifyToken), we also enforce:
 *   - jti not present in token_blocklist   (W-1, per-token revocation)
 *   - tvr matches the principal's current token_version (W-2, bulk revocation)
 */

import { verifyToken } from '../crypto/ed25519.js';
import { config } from '../config.js';
import db from '../db.js';
import { isJtiBlocked, isTokenVersionCurrent } from '../services/tokenSecurity.js';

/**
 * Validate a bot session token (payload {key, session_id, jti, tvr, exp,…}).
 * Also verifies replay + revocation state.
 * Token may arrive either in the JSON body (`token` field) for POST/PUT
 * or via `Authorization: Bearer <b64>` for GET.
 */
export async function validateBotToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const tokenB64 = req.body?.token
    || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
  if (!tokenB64) {
    return res.status(400).json({ error: 'Missing token' });
  }

  const result = await verifyToken(tokenB64, config.bot.ed25519PublicKey);
  if (!result) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { payload } = result;

  if (payload.jti && await isJtiBlocked(db, payload.jti)) {
    return res.status(401).json({ error: 'Token revoked' });
  }

  if (payload.key &&
      !(await isTokenVersionCurrent(db, 'license', payload.key, payload.tvr))) {
    return res.status(401).json({ error: 'Token version outdated' });
  }

  req.botToken    = payload;
  req.botTokenRaw = result.raw;
  next();
}

/**
 * Validate user token from Authorization: Bearer header.
 * Verifies Ed25519 signature, checks type=user, loads user from DB.
 * Attaches user to req.botUser with allowed_channels.
 */
export async function validateBotUserToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }

  const tokenB64 = authHeader.slice(7);
  const result = await verifyToken(tokenB64, config.bot.ed25519PublicKey);
  if (!result) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { payload } = result;
  if (payload.type !== 'user' || !payload.user_id) {
    return res.status(401).json({ error: 'Invalid token type' });
  }

  if (payload.jti && await isJtiBlocked(db, payload.jti)) {
    return res.status(401).json({ error: 'Token revoked' });
  }

  if (!(await isTokenVersionCurrent(db, 'user', payload.user_id, payload.tvr))) {
    return res.status(401).json({ error: 'Token version outdated' });
  }

  const user = await db('users').where('id', payload.user_id).first();
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  req.botUser     = {
    id:               user.id,
    name:             user.name,
    email:            user.email,
    role:             user.role,
    credits:          user.credits || 0,
    allowed_channels: user.allowed_channels ? JSON.parse(user.allowed_channels) : ['release'],
  };
  req.botTokenRaw = result.raw; // raw token bytes for AES key derivation in downloads
  next();
}
