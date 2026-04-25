/**
 * Normalize per-user feature_flags JSON.
 *
 * Migration 013 seeded every existing user with `hwid_spoof: true`, which is
 * a paid shop module — those users effectively got HWID Spoof for free.
 * This migration flips `hwid_spoof` back to `false` for any user who has no
 * `shop.purchase_module` audit entry recording a purchase of that flag.
 *
 * It also fills in missing keys with the canonical default set so the admin
 * UI has a complete view of every flag the current FeatureFlags struct
 * understands. Keys the bot omits read as `false` anyway, but having them
 * present in the stored JSON makes the audit log diff readable when an
 * admin later toggles them.
 *
 * Idempotent: re-running is safe — already-correct rows stay put because
 * the merge keeps existing values for non-hwid_spoof keys, and hwid_spoof
 * is only forced to false when no purchase audit exists.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  // Canonical defaults — must match UserFormDialog DEFAULT_FLAGS so the
  // server-stored shape matches what the UI assumes when rendering.
  // Source of truth: Bot/inject/feature_flags.h. options/ip_profiles/
  // security are always-on in the bot and intentionally not exposed
  // here; they're hard-coded `true` in the FeatureFlags struct.
  const DEFAULT_FLAGS = {
    // User features (non-shop) — default ON
    training: true, skills: true, monsters: true, statistics: true, combo: true,
    // Shop modules — default OFF (admin grants explicitly or user purchases)
    hwid_spoof: false, ip_profiles: false, inventory: false, buffs: false, consumables: false,
    // Dev features — default OFF (require dev master + explicit grant)
    dev: false, dev_movement: false, dev_entities: false, dev_drops: false,
    dev_skills: false, dev_advanced: false, dev_blacklist: false,
    dev_obstacles: false, dev_npc: false, dev_combo: false, dev_terrain: false,
    dev_debug: false, dev_chat: false, dev_inventory: false, dev_buffs: false,
    dev_anticheat: false, dev_packets: false, dev_training: false, dev_animator: false,
  };

  // User IDs that have a recorded shop.purchase_module audit entry for
  // hwid_spoof — those users keep their `true` flag.
  const purchasedRows = await knex('audit_logs')
    .where('action', 'shop.purchase_module')
    .where('subject_type', 'user')
    .where('new_values', 'like', '%"flag_key":"hwid_spoof"%')
    .distinct('subject_id');
  const hwidPurchased = new Set(
    purchasedRows
      .map((r) => Number(r.subject_id))
      .filter((n) => Number.isFinite(n))
  );

  const users = await knex('users').select('id', 'feature_flags');
  for (const u of users) {
    let stored = {};
    if (u.feature_flags) {
      try {
        stored = typeof u.feature_flags === 'string'
          ? JSON.parse(u.feature_flags)
          : u.feature_flags;
      } catch {
        stored = {};
      }
    }

    const merged = { ...DEFAULT_FLAGS, ...stored };
    if (!hwidPurchased.has(u.id)) merged.hwid_spoof = false;

    await knex('users').where('id', u.id).update({
      feature_flags: JSON.stringify(merged),
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down() {
  // No-op: we cannot reconstruct the pre-migration JSON shape and there's
  // no schema change to revert. Re-running `up` is idempotent.
}
