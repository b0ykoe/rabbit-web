/**
 * Spawn-ingest token validation middleware (PLAN_v2 §3.9).
 *
 * Accepts BOTH token types so the Release live-session token and the
 * Debug panel-minted "ingest" token both authenticate the ingest route,
 * while the existing `validateBotToken` on every other route stays
 * completely untouched (this is a NEW middleware, not an edit to that one).
 *
 *   1. verifyToken(raw, pub)  → ed25519 signature + exp (same crypto as
 *      validateBotToken; NOT a JWT — binary [uint32-LE len][JSON][64B sig]).
 *   2. if payload.scope === 'ingest'  → require a live issued_ingest_tokens
 *      row (revoked=false AND expires_at > now). This is the pasted-token
 *      path — ingest-only, per-token revocable, expiring bearer credential.
 *      else (a live session token)     → run the SAME jti-blocklist +
 *      token_version checks validateBotToken uses.
 *
 * Attaches req.botToken / req.botTokenRaw exactly like validateBotToken so
 * downstream resolveUserId + the byBotToken rate-limiter behave identically.
 */

import { verifyToken } from '../crypto/ed25519.js';
import { config } from '../config.js';
import db from '../db.js';
import { isJtiBlocked, isTokenVersionCurrent } from '../services/tokenSecurity.js';

export async function validateSpawnIngest(req, res, next) {
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

  if (payload.scope === 'ingest') {
    // Panel-minted ingest token — must have a live, un-revoked issued row.
    const now = Math.floor(Date.now() / 1000);
    const row = await db('issued_ingest_tokens')
      .where('jti', payload.jti)
      .where('revoked', false)
      .where('expires_at', '>', now)
      .first();
    if (!row) {
      return res.status(401).json({ error: 'Ingest token revoked or unknown' });
    }
  } else {
    // Live session token — same replay/revocation checks as validateBotToken.
    if (payload.jti && await isJtiBlocked(db, payload.jti)) {
      return res.status(401).json({ error: 'Token revoked' });
    }
    if (payload.key &&
        !(await isTokenVersionCurrent(db, 'license', payload.key, payload.tvr))) {
      return res.status(401).json({ error: 'Token version outdated' });
    }
  }

  req.botToken    = payload;
  req.botTokenRaw = result.raw;
  next();
}
