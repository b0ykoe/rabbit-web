/**
 * Bot token validation middleware.
 * Verifies Ed25519-signed tokens from request body or Authorization header.
 */

import { verifyToken } from '../crypto/ed25519.js';
import { config } from '../config.js';
import db from '../db.js';

/**
 * Validate session token from request body (for download endpoints).
 * Attaches decoded payload and raw token to req.botToken / req.botTokenRaw.
 */
export async function validateBotToken(req, res, next) {
  const tokenB64 = req.body?.token;
  if (!tokenB64) {
    return res.status(400).json({ error: 'Missing token' });
  }

  const result = await verifyToken(tokenB64, config.bot.ed25519PublicKey);
  if (!result) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.botToken    = result.payload;
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

  if (result.payload.type !== 'user' || !result.payload.user_id) {
    return res.status(401).json({ error: 'Invalid token type' });
  }

  const user = await db('users').where('id', result.payload.user_id).first();
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  req.botUser     = {
    id:               user.id,
    name:             user.name,
    email:            user.email,
    credits:          user.credits || 0,
    allowed_channels: user.allowed_channels ? JSON.parse(user.allowed_channels) : ['release'],
  };
  req.botTokenRaw = result.raw; // raw token bytes for AES key derivation in downloads
  next();
}
