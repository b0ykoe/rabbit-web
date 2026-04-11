import crypto from 'node:crypto';

/**
 * Generate a license key in XXXX-XXXX-XXXX-XXXX format.
 * @returns {string}
 */
export function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 for readability
  const bytes = crypto.randomBytes(16);
  let key = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) key += '-';
    key += chars[bytes[i] % chars.length];
  }
  return key;
}

/**
 * Check if a license has an available concurrent session slot.
 * @param {import('knex').Knex} db
 * @param {string} licenseKey
 * @param {number} maxSessions
 * @returns {Promise<boolean>}
 */
export async function hasAvailableSlot(db, licenseKey, maxSessions) {
  const cutoff = Math.floor(Date.now() / 1000) - 90;
  const { count } = await db('bot_sessions')
    .where('license_key', licenseKey)
    .where('last_heartbeat', '>', cutoff)
    .count('* as count')
    .first();
  return Number(count) < maxSessions;
}
