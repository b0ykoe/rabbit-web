/**
 * Bot token validation middleware.
 * Verifies the Ed25519-signed token from the request body.
 * Attaches decoded payload and raw token to req.botToken / req.botTokenRaw.
 */

import { verifyToken } from '../crypto/ed25519.js';
import { config } from '../config.js';

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
