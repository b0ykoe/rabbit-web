/**
 * Ed25519 token signing/verification — byte-compatible with PHP sodium.
 *
 * Token binary format (same as Laravel AuthController):
 *   [4-byte LE uint32: payload length][JSON payload][64-byte Ed25519 signature]
 *   Entire thing base64-encoded.
 *
 * Key format:
 *   PHP sodium "secret key" = 64 bytes (32-byte seed + 32-byte pubkey), stored as 128-hex-char string.
 *   @noble/ed25519 expects just the 32-byte seed for signing, 32-byte pubkey for verifying.
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import crypto from 'node:crypto';

// @noble/ed25519 v2 requires setting the hash manually
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/**
 * Generate a random 32-char hex jti (16 random bytes). Used as the
 * unique-token-id claim so a token can be blocklisted in the short
 * window before it naturally expires.
 */
export function generateJti() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Sign arbitrary bytes and return a base64-encoded detached signature.
 * Used for release-artifact signing (W-8) so the bot can verify a
 * downloaded DLL wasn't swapped by a MITM between upload and install.
 * @param {Buffer|Uint8Array} bytes - payload to sign
 * @param {string} privKeyHex - 128-char hex string (64-byte libsodium secret key)
 * @returns {Promise<string>} base64-encoded 64-byte signature (~88 chars)
 */
export async function signBytes(bytes, privKeyHex) {
  const seed = Buffer.from(privKeyHex.slice(0, 64), 'hex');
  const sig  = await ed.signAsync(bytes, seed);
  return Buffer.from(sig).toString('base64');
}

/**
 * Sign a JSON payload and produce a base64-encoded token.
 * @param {object} payload - The token payload (will be JSON-stringified)
 * @param {string} privKeyHex - 128-char hex string (64-byte libsodium secret key)
 * @returns {Promise<string>} base64-encoded token
 */
export async function signToken(payload, privKeyHex) {
  const payloadStr = JSON.stringify(payload);
  const payloadBytes = Buffer.from(payloadStr, 'utf8');

  // Extract 32-byte seed (first 64 hex chars) from the 128-char hex private key
  const seed = Buffer.from(privKeyHex.slice(0, 64), 'hex');

  const sig = await ed.signAsync(payloadBytes, seed);

  // Pack: [uint32 LE payload length][payload][64-byte signature]
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(payloadBytes.length, 0);

  const token = Buffer.concat([lenBuf, payloadBytes, Buffer.from(sig)]);
  return token.toString('base64');
}

/**
 * Parse token payload WITHOUT signature verification or expiry check.
 * Used for token refresh where we need to read exp from a near-expired token.
 * @param {string} tokenB64 - base64-encoded token
 * @returns {object|null} decoded payload, or null if malformed
 */
export function parseTokenPayload(tokenB64) {
  let raw;
  try { raw = Buffer.from(tokenB64, 'base64'); } catch { return null; }
  if (raw.length < 5) return null;

  const payloadLen = raw.readUInt32LE(0);
  if (payloadLen <= 0 || payloadLen > 4096) return null;
  if (raw.length < 4 + payloadLen + 64) return null;

  try {
    return JSON.parse(raw.subarray(4, 4 + payloadLen).toString('utf8'));
  } catch { return null; }
}

/**
 * Verify and decode a base64-encoded signed token.
 * @param {string} tokenB64 - base64-encoded token
 * @param {string} pubKeyHex - 64-char hex string (32-byte public key)
 * @returns {Promise<{payload: object, raw: Buffer}|null>} decoded payload + raw token, or null if invalid
 */
export async function verifyToken(tokenB64, pubKeyHex) {
  let raw;
  try {
    raw = Buffer.from(tokenB64, 'base64');
  } catch {
    return null;
  }

  if (raw.length < 5) return null;

  const payloadLen = raw.readUInt32LE(0);
  if (payloadLen <= 0 || payloadLen > 4096) return null;
  if (raw.length < 4 + payloadLen + 64) return null;

  const payloadBytes = raw.subarray(4, 4 + payloadLen);
  const sig = raw.subarray(4 + payloadLen, 4 + payloadLen + 64);

  if (sig.length !== 64) return null;

  const pubKey = Buffer.from(pubKeyHex, 'hex');
  const valid = await ed.verifyAsync(sig, payloadBytes, pubKey);
  if (!valid) return null;

  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return null;
  }

  // Check expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

  return { payload, raw };
}
