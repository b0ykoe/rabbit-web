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
  // `duration_days` is stashed on the license; `expires_at` stays NULL
  // until the user redeems the key, at which point the redeem handler
  // computes `now + duration_days`. Lifetime products (duration_days=null)
  // keep expires_at=null forever, same as before.
  const durationDays = product.duration_days || null;

  await db.transaction(async (trx) => {
    // Deduct credits
    const user = await trx('users').where('id', userId).forUpdate().first();
    if (user.credits < product.credits_cost) {
      throw new Error('Insufficient credits');
    }
    await trx('users').where('id', userId).update({ credits: user.credits - product.credits_cost });

    // Create license — NOT assigned to user, stored as bought key.
    // expires_at remains NULL until redeem.
    await trx('licenses').insert({
      license_key:   key,
      user_id:       null,
      purchased_by:  userId,
      max_sessions:  product.max_sessions || 1,
      active:        true,
      expires_at:    null,
      duration_days: durationDays,
      note:          `Purchased: ${product.name}`,
    });
  });

  return { license_key: key, expires_at: null, duration_days: durationDays };
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

    // An unredeemed key has expires_at=NULL but duration_days set;
    // extending such a key just grows the banked duration — it still
    // doesn't start running until redeem.
    const isUnredeemed = license.expires_at === null && license.duration_days;

    // Already lifetime — no extension makes sense (would downgrade or no-op)
    if (!license.expires_at && !license.duration_days) {
      throw new Error('License is already lifetime');
    }

    // Deduct credits
    const user = await trx('users').where('id', userId).forUpdate().first();
    if (user.credits < product.credits_cost) {
      throw new Error('Insufficient credits');
    }
    await trx('users').where('id', userId).update({ credits: user.credits - product.credits_cost });

    // Calculate new expiry / duration
    if (!product.duration_days) {
      // Extend to lifetime
      await trx('licenses').where('license_key', licenseKey).update({
        expires_at: null,
        duration_days: null,
      });
      newExpiry = null;
    } else if (isUnredeemed) {
      // Bank more days onto the unredeemed key's duration.
      const newDuration = (license.duration_days || 0) + product.duration_days;
      await trx('licenses').where('license_key', licenseKey).update({
        duration_days: newDuration,
      });
      newExpiry = null;
    } else {
      const base = license.expires_at && new Date(license.expires_at) > new Date()
        ? new Date(license.expires_at)
        : new Date();
      base.setDate(base.getDate() + product.duration_days);
      newExpiry = base.toISOString().slice(0, 19).replace('T', ' ');
      await trx('licenses').where('license_key', licenseKey).update({ expires_at: newExpiry });
    }
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
