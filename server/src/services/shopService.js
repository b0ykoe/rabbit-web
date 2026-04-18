import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKey } from './licenseService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOP_PATH = path.join(__dirname, '../../config/shop.json');

/**
 * Load products from shop.json (re-reads on every call for hot reload).
 * @returns {{ id: string, name: string, type: string, duration_days: number|null, credits_cost: number, max_sessions?: number }[]}
 */
export function loadProducts() {
  const raw = fs.readFileSync(SHOP_PATH, 'utf8');
  const data = JSON.parse(raw);
  return data.products || [];
}

/**
 * Purchase a new license.
 * @param {import('knex').Knex} db
 * @param {number} userId
 * @param {object} product - from shop.json
 * @returns {Promise<{ license_key: string, expires_at: string|null }>}
 */
export async function purchaseNewLicense(db, userId, product) {
  const key = generateKey();
  const expiresAt = product.duration_days
    ? new Date(Date.now() + product.duration_days * 86400000).toISOString().slice(0, 19).replace('T', ' ')
    : null;

  await db.transaction(async (trx) => {
    // Deduct credits
    const user = await trx('users').where('id', userId).forUpdate().first();
    if (user.credits < product.credits_cost) {
      throw new Error('Insufficient credits');
    }
    await trx('users').where('id', userId).update({ credits: user.credits - product.credits_cost });

    // Create license — NOT assigned to user, stored as bought key
    await trx('licenses').insert({
      license_key:  key,
      user_id:      null,
      purchased_by: userId,
      max_sessions: product.max_sessions || 1,
      active:       true,
      expires_at:   expiresAt,
      note:         `Purchased: ${product.name}`,
    });
  });

  return { license_key: key, expires_at: expiresAt };
}

/**
 * Extend an existing license.
 * @param {import('knex').Knex} db
 * @param {number} userId
 * @param {string} licenseKey
 * @param {object} product - from shop.json
 * @returns {Promise<{ expires_at: string|null }>}
 */
export async function extendLicense(db, userId, licenseKey, product) {
  let newExpiry;

  await db.transaction(async (trx) => {
    // Verify ownership
    const license = await trx('licenses').where({ license_key: licenseKey, user_id: userId }).forUpdate().first();
    if (!license) throw new Error('License not found or not owned by you');
    if (!license.active) throw new Error('License is revoked');

    // Already lifetime — no extension makes sense (would downgrade or no-op)
    if (!license.expires_at) {
      throw new Error('License is already lifetime');
    }

    // Deduct credits
    const user = await trx('users').where('id', userId).forUpdate().first();
    if (user.credits < product.credits_cost) {
      throw new Error('Insufficient credits');
    }
    await trx('users').where('id', userId).update({ credits: user.credits - product.credits_cost });

    // Calculate new expiry
    if (!product.duration_days) {
      // Extend to lifetime
      newExpiry = null;
    } else {
      const base = license.expires_at && new Date(license.expires_at) > new Date()
        ? new Date(license.expires_at)
        : new Date();
      base.setDate(base.getDate() + product.duration_days);
      newExpiry = base.toISOString().slice(0, 19).replace('T', ' ');
    }

    await trx('licenses').where('license_key', licenseKey).update({ expires_at: newExpiry });
  });

  return { expires_at: newExpiry };
}

/**
 * Purchase a module (enable a feature flag).
 * @param {import('knex').Knex} db
 * @param {number} userId
 * @param {object} product - from shop.json, must have flag_key
 * @returns {Promise<{ flag_key: string, enabled: boolean }>}
 */
export async function purchaseModule(db, userId, product) {
  await db.transaction(async (trx) => {
    const user = await trx('users').where('id', userId).forUpdate().first();
    if (user.credits < product.credits_cost) {
      throw new Error('Insufficient credits');
    }

    const flags = user.feature_flags ? (typeof user.feature_flags === 'string' ? JSON.parse(user.feature_flags) : user.feature_flags) : {};
    if (flags[product.flag_key]) {
      throw new Error('Module already owned');
    }

    flags[product.flag_key] = true;
    await trx('users').where('id', userId).update({
      credits: user.credits - product.credits_cost,
      feature_flags: JSON.stringify(flags),
    });
  });

  return { flag_key: product.flag_key, enabled: true };
}
