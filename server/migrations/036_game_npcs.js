//
// 036_game_npcs.js
//
// Per-server NPC LIST: the human-readable NPC names (plus a coarse type label
// and home zone) for a given game server. The bot enumerates every placed NPC
// from the client Map.dta via NpcCatalog and dumps them alongside the zone and
// mob names; the super-admin import REPLACE-ALL's this list per server in the
// same transaction as game_zones / mob_names. The portal then serves them back
// so the admin overview can browse NPCs by name/type/zone.
//
// Like 035's reference lists this is a pure name lookup keyed by
// (server_id, npc_id) — no version bucket, no session attribution. STRICTLY
// ADDITIVE on top of 035: no existing table or column is altered.
//
//   game_npcs              — one row per (server, npc).
//       server_id  INT UNSIGNED NOT NULL  upserted game server.
//       npc_id     INT          NOT NULL  NpcCatalog entry id.
//       name       VARCHAR(96)  NOT NULL  cleaned NPC name.
//       type       VARCHAR(32)  NULL      coarse label (Merchant/Teleporter/...).
//       zone_no    INT          NULL      home zone of first placement (-1 → null).
//       updated_at BIGINT       NOT NULL  last replace-all time (epoch sec).
//       PRIMARY KEY(server_id, npc_id).
//
// The create is hasTable-guarded so a re-run is a no-op; down() drops game_npcs
// (guarded).
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── game_npcs ────────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('game_npcs'))) {
    await knex.schema.createTable('game_npcs', (t) => {
      t.integer('server_id').unsigned().notNullable();   // upserted game server
      t.integer('npc_id').notNullable();                 // NpcCatalog entry id
      t.string('name', 96).notNullable();                // cleaned NPC name
      t.string('type', 32).nullable();                   // coarse label
      t.integer('zone_no').nullable();                   // home zone of first spot
      t.bigInteger('updated_at').notNullable();
      t.primary(['server_id', 'npc_id']);
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Reverse: drop game_npcs.
  if (await knex.schema.hasTable('game_npcs')) {
    await knex.schema.dropTable('game_npcs');
  }
}
