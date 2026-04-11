/**
 * AES-256-CBC encryption — byte-compatible with PHP openssl_encrypt.
 *
 * Key derivation: SHA-256(raw_token_bytes) → 32-byte AES key
 * Same as PHP: hash('sha256', $rawToken, true)
 */

import crypto from 'node:crypto';

/**
 * Encrypt a file buffer with AES-256-CBC.
 * @param {Buffer} plaintext - raw file content
 * @param {Buffer} rawToken  - raw token bytes (used to derive AES key)
 * @returns {{ iv: string, data: string }} - hex IV and base64 ciphertext
 */
export function encryptFile(plaintext, rawToken) {
  const aesKey = crypto.createHash('sha256').update(rawToken).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    iv:   iv.toString('hex'),
    data: enc.toString('base64'),
  };
}
