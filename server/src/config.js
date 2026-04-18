import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

// Fail-fast helper: throw with a clear message when a secret is missing.
// A missing key silently falling back to '' is a security disaster — every
// token would be forgeable. Catch it at boot instead of in production.
function requireSecret(name, minLength = 1) {
  const value = process.env[name];
  if (!value || value.length < minLength) {
    throw new Error(
      `[config] Missing or invalid secret: ${name} ` +
      `(expected non-empty string${minLength > 1 ? ` >= ${minLength} chars` : ''}). ` +
      `Populate it in .env before starting the server.`
    );
  }
  return value;
}

const isProd = (process.env.NODE_ENV || 'development') === 'production';

export const config = {
  env:  process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,

  db: {
    host:     process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT, 10) || 3306,
    database: process.env.DB_DATABASE || 'botauth',
    user:     process.env.DB_USERNAME || 'botauth',
    password: process.env.DB_PASSWORD || '',
  },

  // Session secret is ALWAYS required — a weak/empty one means cookies
  // can be forged. CHANGE_ME was a leftover dev default that forced its
  // way into deployments; now it's a boot-time error.
  sessionSecret: requireSecret('SESSION_SECRET', 32),

  bot: {
    // Ed25519 keys are hex strings (128 chars private = 64-byte libsodium
    // secret key; 64 chars public = 32-byte pubkey). Both required.
    ed25519PrivateKey: requireSecret('BOT_ED25519_PRIVATE_KEY', 128),
    ed25519PublicKey:  requireSecret('BOT_ED25519_PUBLIC_KEY',  64),
    privateDir:        process.env.BOT_PRIVATE_DIR || './private/releases',
    sessionTimeoutSec: 30,  // sessions without heartbeat for this long are considered dead
  },

  isProd,
};
