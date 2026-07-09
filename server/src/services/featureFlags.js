// Feature-flag evaluation backed by the feature_flag_catalog table (042).
//
// Effective value per flag:  enabled_globally && (super_admin || userValue)
// where userValue = the user's stored feature_flags JSON entry, falling back
// to the catalog's default_value when the key is missing.
//
// `enabled_globally` is the fleet-wide kill-switch — it beats the super-admin
// bypass on purpose, so an operator can stop a misbehaving feature for
// EVERYONE from the admin Settings page without touching user rows.
//
// Legacy fallback: if the catalog table doesn't exist yet (server deployed
// before `npm run migrate` ran), fall back to the pre-042 behaviour so bot
// logins never break mid-deploy.

import db from '../db.js';

// Pre-042 super-admin map, kept ONLY as the legacy fallback (see header).
const LEGACY_ALL_TRUE = Object.freeze({
  training: true, skills: true, monsters: true, statistics: true,
  combo: true, options: true, hwid_spoof: true,
  inventory: true, buffs: true, consumables: true,
  dev: true, dev_movement: true, dev_entities: true, dev_drops: true,
  dev_skills: true, dev_advanced: true, dev_blacklist: true,
  dev_obstacles: true, dev_npc: true, dev_combo: true,
  dev_terrain: true, dev_debug: true, dev_chat: true,
  dev_inventory: true, dev_buffs: true, dev_anticheat: true,
  dev_packets: true, dev_training: true, dev_animator: true,
  spawn_tracking: true,
});

function parseStoredFlags(user) {
  if (!user?.feature_flags) return {};
  try {
    const v = typeof user.feature_flags === 'string'
      ? JSON.parse(user.feature_flags)
      : user.feature_flags;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Build the effective feature-flag map sent to the bot for `user`
 * (a users row with at least `role` and `feature_flags`; null → {}).
 */
export async function effectiveFlagsFor(user) {
  if (!user) return {};
  const stored  = parseStoredFlags(user);
  const isSuper = user.role === 'super_admin';

  let catalog;
  try {
    catalog = await db('feature_flag_catalog')
      .select('flag_key', 'default_value', 'enabled_globally');
  } catch {
    catalog = null; // table missing (pre-migrate window) → legacy behaviour
  }
  if (!catalog || catalog.length === 0) {
    return isSuper ? { ...LEGACY_ALL_TRUE } : stored;
  }

  const out = {};
  for (const row of catalog) {
    const userVal = isSuper
      ? true
      : (row.flag_key in stored ? !!stored[row.flag_key] : !!row.default_value);
    out[row.flag_key] = !!row.enabled_globally && userVal;
  }
  // Transition safety: stored keys that predate their catalog row still pass
  // through (no global kill-switch exists for them yet). The bot ignores
  // keys it doesn't know.
  for (const [k, v] of Object.entries(stored)) {
    if (!(k in out)) out[k] = isSuper ? true : !!v;
  }
  return out;
}

/**
 * Effective boolean for one flag — used by server-side gates
 * (e.g. requireSpawnTracking). Same semantics as effectiveFlagsFor.
 */
export async function flagEnabledFor(user, flagKey) {
  if (!user) return false;
  let row = null;
  try {
    row = await db('feature_flag_catalog')
      .where('flag_key', flagKey)
      .select('default_value', 'enabled_globally')
      .first();
  } catch {
    row = null;
  }
  const isSuper = user.role === 'super_admin';
  if (!row) {
    // Legacy: no catalog → old semantics (super bypasses, others need the key).
    if (isSuper) return true;
    const stored = parseStoredFlags(user);
    return !!stored[flagKey];
  }
  if (!row.enabled_globally) return false;   // kill-switch beats everyone
  if (isSuper) return true;
  const stored = parseStoredFlags(user);
  return flagKey in stored ? !!stored[flagKey] : !!row.default_value;
}
