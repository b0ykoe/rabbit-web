//
// 030_monster_spawn_versions.js
//
// Per-version (per-scan-session) spawn heat — STEP 3 of versioned-spots
// (PLAN_v3 §revisions). STRICTLY ADDITIVE on top of 029: not one existing
// table/column is touched. The all-time `mob_spawn_cells` stays the sole
// source of the legacy dashboards; these two new tables carry the SAME
// additive-delta heat bucketed by a version_id so the read API can serve
// "newest revision per spot" / "this exact version" without any calendar or
// timezone math.
//
//   version_id            — the TRANSMITTED run_id, used DIRECTLY as the bucket
//                           (bigint). One scan session (run) == one version.
//                           NO floor(ts/86400) — the run_id IS the bucket key.
//
//   mob_spawn_cell_versions — the versioned heat. Same 6-column spot key as
//                           mob_spawn_cells (server, zone_no, mob_id, cell_x,
//                           cell_z, channel) PLUS version_id as the 7th PK
//                           column. Additive deltas: hits, passes, instance_sum
//                           (the portal ADDs the bot's per-cell deltas, guarded
//                           by last_hit_run_id/last_pass_run_id exactly like the
//                           all-time path so a re-sent batch adds nothing).
//                           y_avg is the batch-mean height snapshot for the
//                           version; first_seen_sec/last_seen_sec bracket it.
//
//   spawn_version_meta    — one row per (server, zone, version). ver_start_sec /
//                           ver_end_sec bracket the version's observation window
//                           (min first_seen / max last_seen across its cells);
//                           run_count accumulates the number of per-version cell-row
//                           writes across ingests (not a distinct-ingest count).
//
// All creates hasTable-guarded; down() drops in reverse. No existing table is
// touched — purely additive.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── mob_spawn_cell_versions ──────────────────────────────────────────────
  // The versioned heat. PK = the existing 6-col spot key + version_id. A given
  // (spot, version) row accumulates the additive deltas for THAT scan session.
  if (!(await knex.schema.hasTable('mob_spawn_cell_versions'))) {
    await knex.schema.createTable('mob_spawn_cell_versions', (t) => {
      t.integer('server_id').unsigned().notNullable();
      t.integer('zone_no').notNullable();
      t.integer('mob_id').notNullable();
      t.integer('cell_x').notNullable();          // floor((world - origin)/4) [B1]
      t.integer('cell_z').notNullable();
      t.integer('channel').notNullable().defaultTo(0); // NOT NULL DEFAULT 0 — mirrors 029
      t.bigInteger('version_id').notNullable();   // = transmitted run_id, the bucket key
      // v2 additive-delta heat, per-version. Same semantics as mob_spawn_cells:
      // the ingest route does `col = col + ?` (NEVER a bare .merge()), run_id-guarded.
      t.integer('hits').notNullable().defaultTo(0);          // Σ times this mob was seen in the cell (this version)
      t.integer('passes').notNullable().defaultTo(0);        // Σ times the cell was traversed empty (this version)
      t.integer('instance_sum').notNullable().defaultTo(0);  // Σ concurrent instances → typical group size
      t.bigInteger('last_hit_run_id').defaultTo(0);          // last run whose hit delta was applied (distinct-runs)
      t.bigInteger('last_pass_run_id').defaultTo(0);         // last run whose pass delta was applied
      t.float('y_avg').nullable();                           // running mean of h [A8][B6]
      t.bigInteger('first_seen_sec').notNullable();
      t.bigInteger('last_seen_sec').notNullable();
      t.primary(['server_id', 'zone_no', 'mob_id', 'cell_x', 'cell_z', 'channel', 'version_id']);
      // Newest-per-spot / per-zone scans and per-mob scans both order by version_id.
      t.index(['server_id', 'zone_no', 'version_id'], 'idx_spawn_ver_server_zone_ver');
      t.index(['server_id', 'mob_id', 'version_id'], 'idx_spawn_ver_server_mob_ver');
    });
  }

  // ── spawn_version_meta ───────────────────────────────────────────────────
  // One row per (server, zone, version). Brackets the version's observation
  // window and counts how many ingests touched it. Latest ingest widens the
  // window (ver_start = min first_seen, ver_end = max last_seen).
  if (!(await knex.schema.hasTable('spawn_version_meta'))) {
    await knex.schema.createTable('spawn_version_meta', (t) => {
      t.integer('server_id').unsigned().notNullable();
      t.integer('zone_no').notNullable();
      t.bigInteger('version_id').notNullable();
      t.bigInteger('ver_start_sec').notNullable();   // min first_seen across this version's cells
      t.bigInteger('ver_end_sec').notNullable();     // max last_seen across this version's cells
      t.integer('run_count').notNullable().defaultTo(0);
      t.bigInteger('updated_at').notNullable();
      t.primary(['server_id', 'zone_no', 'version_id']);
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Reverse creation order.
  if (await knex.schema.hasTable('spawn_version_meta')) {
    await knex.schema.dropTable('spawn_version_meta');
  }
  if (await knex.schema.hasTable('mob_spawn_cell_versions')) {
    await knex.schema.dropTable('mob_spawn_cell_versions');
  }
}
