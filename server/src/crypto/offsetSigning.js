/**
 * Offset-blob signing (Portal offset-override system, Phase D).
 *
 * SECURITY MODEL
 *   The Ed25519 signing key for offset blobs is DELIBERATELY SEPARATE from the
 *   always-hot BOT_ED25519_PRIVATE_KEY used to sign bot tokens. That key lives in
 *   an env var and is decrypted-at-rest never — it is hot the whole time the
 *   process runs. An offset blob signs a live-editable value that a bot trusts
 *   enough to poke into GameLayout (a forged blob = RCE on every bot), so its
 *   private key is stored ONLY password-wrapped (scrypt-derived AES-256-GCM) and
 *   is decrypted in-memory ONLY for the duration of a single sign call, then the
 *   plaintext buffer is zeroed. The password is NEVER stored, logged, or audited.
 *
 * WRAP FORMAT (enc_private_key)
 *   base64( salt(16) | iv(12) | authTag(16) | ciphertext(32) )
 *   - salt  : scrypt salt (crypto.randomBytes(16))
 *   - iv    : AES-GCM nonce (crypto.randomBytes(12))
 *   - tag   : AES-GCM auth tag (16). A WRONG PASSWORD → GCM auth failure on
 *             decrypt → thrown OffsetKeyAuthError (no plaintext leaked).
 *   - ct    : the 32-byte Ed25519 seed (private key) encrypted.
 *
 * BLOB FORMAT (what the bot verifies in Phase E — kept dead simple, NO
 * canonicalization needed)
 *   { payload_b64, signature_b64 }
 *     payload      = utf8 bytes of JSON.stringify({ server_id, stamp, size, fields })
 *     payload_b64  = base64(payload)
 *     signature_b64= base64( Ed25519_sign(payload) )   // signed over THOSE EXACT bytes
 *   The bot base64-decodes payload_b64, verifies the signature over the raw
 *   decoded bytes with its compiled pubkey, THEN json-parses — so neither side
 *   ever re-serializes for a canonical form.
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import crypto from 'node:crypto';

// @noble/ed25519 v2 requires the sha512 hook wired manually (mirrors ed25519.js).
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// scrypt cost. N=2^15 (32768) is the spec'd work factor; r/p at the node
// defaults. maxmem is bumped so N=2^15 doesn't trip the default 32 MB ceiling.
const SCRYPT_N       = 1 << 15;
const SCRYPT_R       = 8;
const SCRYPT_P       = 1;
const SCRYPT_MAXMEM  = 64 * 1024 * 1024;
const SCRYPT_KEYLEN  = 32;   // AES-256 key
const SALT_LEN       = 16;
const IV_LEN         = 12;
const TAG_LEN        = 16;
const SEED_LEN       = 32;   // Ed25519 seed / private key

/**
 * Thrown when unwrapping the private key fails GCM authentication — i.e. the
 * caller supplied the WRONG signing password. Callers map this to a clean 403
 * with no detail leaked. A distinct class so a bad password is never confused
 * with a programming error.
 */
export class OffsetKeyAuthError extends Error {
  constructor(message = 'Wrong signing password') {
    super(message);
    this.name = 'OffsetKeyAuthError';
  }
}

// Derive the AES-256 key from (password, salt) via scrypt. Kept internal — the
// derived key is never returned to a caller.
function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Generate a fresh Ed25519 keypair and password-wrap the private key.
 * NEVER returns the private key or the password.
 * @param {string} password
 * @returns {Promise<{ public_key_hex: string, enc_private_key: string }>}
 */
export async function generateKeypair(password) {
  const seed = ed.utils.randomPrivateKey();               // 32-byte Uint8Array
  try {
    const pub = await ed.getPublicKeyAsync(seed);         // 32-byte pubkey
    const publicKeyHex = Buffer.from(pub).toString('hex');

    const salt = crypto.randomBytes(SALT_LEN);
    const iv   = crypto.randomBytes(IV_LEN);
    const key  = deriveKey(password, salt);
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct  = Buffer.concat([cipher.update(Buffer.from(seed)), cipher.final()]);
      const tag = cipher.getAuthTag();
      const enc_private_key = Buffer.concat([salt, iv, tag, ct]).toString('base64');
      return { public_key_hex: publicKeyHex, enc_private_key };
    } finally {
      key.fill(0);
    }
  } finally {
    // Zero the seed so the raw private key never lingers in memory.
    seed.fill(0);
  }
}

// Unwrap the encrypted private key → the 32-byte seed. A wrong password makes
// GCM auth fail → OffsetKeyAuthError. The returned Buffer MUST be .fill(0)'d by
// the caller once done. Internal.
function unwrapPrivateKey(password, encPrivateKey) {
  let raw;
  try {
    raw = Buffer.from(encPrivateKey, 'base64');
  } catch {
    throw new OffsetKeyAuthError('Malformed encrypted key');
  }
  if (raw.length !== SALT_LEN + IV_LEN + TAG_LEN + SEED_LEN) {
    throw new OffsetKeyAuthError('Malformed encrypted key');
  }
  const salt = raw.subarray(0, SALT_LEN);
  const iv   = raw.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag  = raw.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ct   = raw.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const key = deriveKey(password, salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      // .final() throws on a bad auth tag — i.e. the WRONG PASSWORD. Surface a
      // typed error and leak nothing.
      throw new OffsetKeyAuthError();
    }
  } finally {
    key.fill(0);
  }
}

/**
 * Sign the EXACT payload bytes with the password-wrapped private key.
 * Deterministic (Ed25519). Zeroes the unwrapped private key before returning.
 * @param {Buffer|Uint8Array} payloadBytes - the raw bytes to sign
 * @param {string} password
 * @param {string} encPrivateKey - the stored enc_private_key
 * @returns {Promise<Buffer>} 64-byte signature
 * @throws {OffsetKeyAuthError} on a wrong password
 */
export async function signPayload(payloadBytes, password, encPrivateKey) {
  const seed = unwrapPrivateKey(password, encPrivateKey);
  try {
    const sig = await ed.signAsync(payloadBytes, seed);
    return Buffer.from(sig);
  } finally {
    seed.fill(0);
  }
}

/**
 * Build the signed blob object the bot verifies.
 * payload = JSON.stringify({ server_id, stamp, size, fields }) utf8 bytes; the
 * signature is over THOSE EXACT bytes (no canonicalization anywhere).
 * @param {number} serverId
 * @param {number|string} stamp - engine TimeDateStamp
 * @param {number|string} size  - engine SizeOfImage
 * @param {Object<string, number>} fieldsObj - { field_name: int, ... }
 * @param {string} password
 * @param {string} encPrivateKey
 * @returns {Promise<{ payload_b64: string, signature_b64: string }>}
 */
export async function buildBlob(serverId, stamp, size, fieldsObj, password, encPrivateKey) {
  const payloadObj = {
    server_id: serverId,
    stamp,
    size,
    fields: fieldsObj,
  };
  const payloadBytes = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const sig = await signPayload(payloadBytes, password, encPrivateKey);
  return {
    payload_b64:   payloadBytes.toString('base64'),
    signature_b64: sig.toString('base64'),
  };
}
