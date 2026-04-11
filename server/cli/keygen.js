#!/usr/bin/env node

/**
 * Generate an Ed25519 keypair for bot token signing.
 *
 * Usage: node server/cli/keygen.js
 *        npm run keygen
 *
 * Output format matches PHP BotKeygen.php exactly:
 *   - BOT_ED25519_PRIVATE_KEY: 128-hex-char libsodium-format secret key (seed + pubkey)
 *   - BOT_ED25519_PUBLIC_KEY:  64-hex-char public key
 *   - C++ byte array for embedding in inject.dll / loader.exe
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import crypto from 'node:crypto';

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

async function main() {
  // Generate 32-byte random seed
  const seed = crypto.randomBytes(32);

  // Derive public key
  const pubKey = await ed.getPublicKeyAsync(seed);

  // Construct libsodium-format secret key: seed (32 bytes) + pubkey (32 bytes) = 64 bytes
  const secretKey = Buffer.concat([seed, Buffer.from(pubKey)]);

  const privHex = secretKey.toString('hex');   // 128 hex chars
  const pubHex  = Buffer.from(pubKey).toString('hex'); // 64 hex chars

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log();
  console.log(`Ed25519 Keypair — generated ${now}`);
  console.log();
  console.log('Add these to your .env (server only — never commit):');
  console.log();
  console.log(`BOT_ED25519_PRIVATE_KEY=${privHex}`);
  console.log(`BOT_ED25519_PUBLIC_KEY=${pubHex}`);
  console.log();
  console.log('Embed this public key in inject.dll / loader.exe (Phase 4):');
  console.log();

  // C++ byte array
  const cppBytes = Array.from(pubKey).map(b => `0x${b.toString(16).padStart(2, '0').toUpperCase()}`).join(', ');
  console.log('// 32-byte Ed25519 public key');
  console.log(`static const uint8_t kPublicKey[32] = { ${cppBytes} };`);
  console.log();
  console.log('IMPORTANT: The private key stays on the server only.');
  console.log('Anyone with the private key can forge valid tokens.');
  console.log();
}

main().catch(console.error);
