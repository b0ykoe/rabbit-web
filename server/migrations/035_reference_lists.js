//
// 035_reference_lists.js
//
// Per-server REFERENCE LISTS: the human-readable ZONE and MONSTER names for a
// given game server. The bot dumps them once (client mob-DB + teleport zone
// table) via POST /api/bot/world/names, which REPLACE-ALL's each list per
// server in one transaction. The portal then serves them back to the client so
// the monster-map can label zones/mobs by name instead of raw ids.
//
// These are pure name lookups keyed by (server_id, id) — no version bucket, no
// session attribution. STRICTLY ADDITIVE on top of 034: no existing table or
// column is altered.
//
//   game_zones             — one row per (server, zone).
//       server_id  INT UNSIGNED NOT NULL  upserted game server.
//       zone_no    INT          NOT NULL  engine zone number (== TeleportData index).
//       name       VARCHAR(128) NOT NULL  zone label (wldFileName).
//       updated_at BIGINT       NOT NULL  last replace-all time (epoch sec).
//       PRIMARY KEY(server_id, zone_no).
//
//   mob_names              — one row per (server, mob).
//       server_id  INT UNSIGNED NOT NULL  upserted game server.
//       mob_id     INT          NOT NULL  mobDBIndex.
//       name       VARCHAR(96)  NOT NULL  cleaned monster name.
//       updated_at BIGINT       NOT NULL  last replace-all time (epoch sec).
//       PRIMARY KEY(server_id, mob_id).
//
// Both creates are hasTable-guarded so a re-run is a no-op; down() drops
// mob_names first, then game_zones (both guarded).
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── game_zones ───────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('game_zones'))) {
    await knex.schema.createTable('game_zones', (t) => {
      t.integer('server_id').unsigned().notNullable();   // upserted game server
      t.integer('zone_no').notNullable();                // engine zone number
      t.string('name', 128).notNullable();               // zone label (wldFileName)
      t.bigInteger('updated_at').notNullable();
      t.primary(['server_id', 'zone_no']);
    });
  }

  // ── mob_names ────────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('mob_names'))) {
    await knex.schema.createTable('mob_names', (t) => {
      t.integer('server_id').unsigned().notNullable();   // upserted game server
      t.integer('mob_id').notNullable();                 // mobDBIndex
      t.string('name', 96).notNullable();                // cleaned monster name
      t.bigInteger('updated_at').notNullable();
      t.primary(['server_id', 'mob_id']);
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Reverse: drop mob_names first, then game_zones.
  if (await knex.schema.hasTable('mob_names')) {
    await knex.schema.dropTable('mob_names');
  }
  if (await knex.schema.hasTable('game_zones')) {
    await knex.schema.dropTable('game_zones');
  }
}
