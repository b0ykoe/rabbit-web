/**
 * Feature-flag catalog — single data-driven registry for every flag the bot
 * understands, replacing the four hardcoded key lists that had to be kept in
 * sync by hand (Bot/inject/feature_flags.h, bot.auth.js ALL_FEATURES_TRUE,
 * migration 024 DEFAULT_FLAGS, UserFormDialog.jsx FEATURE_FLAG_GROUPS).
 *
 * From now on adding a flag = one row here (or via a follow-up seed
 * migration) + the bot struct member. The admin user editor renders its
 * checkboxes from this catalog, and bot.auth.js builds the effective flag
 * map from catalog defaults + per-user overrides.
 *
 * `enabled_globally` is a per-flag KILL-SWITCH: the effective value sent to
 * the bot is `enabled_globally && (super_admin || per_user_value)`. Turning
 * it off disables the feature for EVERYONE (including super-admins) without
 * touching any user rows — e.g. to stop spawn_tracking uploads fleet-wide
 * while investigating a data problem.
 *
 * Note: the seed list is a strict superset of ALL_FEATURES_TRUE, which had
 * silently drifted (it was missing dev_training and dev_animator).
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('feature_flag_catalog', (t) => {
    t.string('flag_key', 64).primary();
    t.string('label', 128).notNullable();
    t.string('group_label', 64).notNullable();     // UI grouping ("User Features" / "Developer")
    t.boolean('is_shop').notNullable().defaultTo(false);   // sold as shop module → default OFF for new users
    t.boolean('default_value').notNullable().defaultTo(false); // per-user default when the user JSON lacks the key
    t.boolean('enabled_globally').notNullable().defaultTo(true); // kill-switch (see header)
    t.integer('sort').notNullable().defaultTo(0);  // display order inside the group
  });

  const USER = 'User Features';
  const DEV  = 'Developer';
  // [key, label, group, is_shop, default_value]
  const rows = [
    ['training',       'Training',              USER, false, true ],
    ['skills',         'Skills',                USER, false, true ],
    ['monsters',       'Monsters',              USER, false, true ],
    ['statistics',     'Statistics',            USER, false, true ],
    ['combo',          'Combo',                 USER, false, true ],
    ['inventory',      'Inventory',             USER, true,  false],
    ['buffs',          'Buffs',                 USER, true,  false],
    ['consumables',    'Consumables',           USER, true,  false],
    ['hwid_spoof',     'HWID Spoof',            USER, true,  false],
    ['ip_profiles',    'IP Profiles (SOCKS5)',  USER, true,  false],
    ['spawn_tracking', 'Spawn Tracking',        USER, false, false],
    ['dev',            'Dev (Master)',          DEV,  false, false],
    ['dev_movement',   'Movement',              DEV,  false, false],
    ['dev_entities',   'Entities',              DEV,  false, false],
    ['dev_drops',      'Drops',                 DEV,  false, false],
    ['dev_skills',     'Skills (Dev)',          DEV,  false, false],
    ['dev_advanced',   'Advanced',              DEV,  false, false],
    ['dev_blacklist',  'Blacklist',             DEV,  false, false],
    ['dev_obstacles',  'Obstacles',             DEV,  false, false],
    ['dev_npc',        'NPC',                   DEV,  false, false],
    ['dev_combo',      'Combo (Dev)',           DEV,  false, false],
    ['dev_terrain',    'Terrain',               DEV,  false, false],
    ['dev_debug',      'Debug',                 DEV,  false, false],
    ['dev_chat',       'Chat',                  DEV,  false, false],
    ['dev_inventory',  'Inventory (Dev)',       DEV,  false, false],
    ['dev_buffs',      'Buffs (Dev)',           DEV,  false, false],
    ['dev_anticheat',  'AntiCheat',             DEV,  false, false],
    ['dev_packets',    'Packets',               DEV,  false, false],
    ['dev_training',   'Training (Dev)',        DEV,  false, false],
    ['dev_animator',   'Animator',              DEV,  false, false],
  ];

  await knex('feature_flag_catalog').insert(
    rows.map(([flag_key, label, group_label, is_shop, default_value], i) => ({
      flag_key, label, group_label, is_shop, default_value,
      enabled_globally: true,
      sort: i,
    }))
  );
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('feature_flag_catalog');
}
