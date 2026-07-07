//
// 029_monster_spawn_map.js
//
// Channel-aware monster-map ingest schema (PLAN_v2 §3.6, phase P0). All
// tables are greenfield — 028 is the highest migration on disk — so the
// channel dimension goes into the v1 primary key of mob_spawn_cells now
// (free today; a table-rewrite forever after a channel-less v1 ships).
//
//   game_servers          — one row per (ip, variant) game server [E4].
//                           `port` stored for a future re-split without re-ingest.
//                           `visible` gates public display (admin confirms first).
//   mob_catalog           — per-server mob dictionary. level_* and maxhp_* are
//                           WIDENING ranges (LEAST/GREATEST on upsert), never per-row.
//   mob_spawn_cells        — the heat data. Quantized 4 m cells keyed
//                           (server, zone_no, mob_id, cell_x, cell_z, CHANNEL).
//                           channel INT NOT NULL DEFAULT 0 — 0 = agnostic/legacy
//                           bucket so old bots that POST no channel collapse as today.
//                           v2 heat = ADDITIVE deltas: hits (times seen), passes
//                           (times the cell was traversed empty), instance_sum
//                           (Σ concurrent instances) — the portal ADDS the bot's
//                           per-cell deltas (never re-adds a cumulative total → no
//                           super-linear inflation). last_hit_run_id/last_pass_run_id
//                           make the deltas distinct-runs when a run_id is sent.
//   zone_bounds            — [B2] persisted per-zone bounds/origin source, captured
//                           from the map-export calibration. Feeds ingest coordinate
//                           validation + PNG framing + web canvas placement [B3].
//   issued_ingest_tokens   — §3.9 panel-minted ingest tokens (scope:'ingest'),
//                           per-token revocable + expiring bearer credentials.
//
// All creates hasTable-guarded; down() drops in reverse. No existing table
// is touched — purely additive.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── game_servers ─────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('game_servers'))) {
    await knex.schema.createTable('game_servers', (t) => {
      t.increments('id').primary();
      t.string('ip', 45).notNullable();          // remote game-socket IP (IPv4 today, room for IPv6)
      t.string('variant', 32).notNullable();     // 'Nemesis' | 'EP4 Stock' | 'Unknown'
      t.string('port', 8).nullable();            // channel discriminator [E4] — stored for future re-split
      t.string('display_name', 128).nullable();  // admin-confirmed name; required before public visibility
      t.boolean('visible').notNullable().defaultTo(false);
      t.bigInteger('first_seen').notNullable();  // unix seconds
      t.bigInteger('last_seen').notNullable();
      t.unique(['ip', 'variant']);               // provisional identity [E4]
    });
  }

  // ── mob_catalog ──────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('mob_catalog'))) {
    await knex.schema.createTable('mob_catalog', (t) => {
      t.integer('server_id').unsigned().notNullable();
      t.integer('mob_id').notNullable();          // mobDBIndex (>0 only; -1 dropped upstream [A2])
      t.string('name', 96).nullable();            // spoofable client string — display only [A8]
      t.integer('level_min').nullable();          // widens via LEAST on upsert
      t.integer('level_max').nullable();          // widens via GREATEST on upsert
      t.integer('maxhp_min').nullable();          // widens via LEAST
      t.integer('maxhp_max').nullable();          // widens via GREATEST
      t.bigInteger('sightings_total').notNullable().defaultTo(0);
      t.bigInteger('last_seen').notNullable();
      t.primary(['server_id', 'mob_id']);
    });
  }

  // ── mob_spawn_cells ──────────────────────────────────────────────────────
  // The heat data. channel is the NEW LEADING sub-dimension inside a server,
  // baked into the v1 PK. 0 = agnostic/legacy (old bots) → collapse as today.
  if (!(await knex.schema.hasTable('mob_spawn_cells'))) {
    await knex.schema.createTable('mob_spawn_cells', (t) => {
      t.integer('server_id').unsigned().notNullable();
      t.integer('zone_no').notNullable();
      t.integer('mob_id').notNullable();
      t.integer('cell_x').notNullable();          // floor((world - origin)/4) [B1]
      t.integer('cell_z').notNullable();
      t.integer('channel').notNullable().defaultTo(0); // NOT NULL DEFAULT 0 — no NULLs, ever
      t.float('y_avg').nullable();                // running mean of h [A8][B6]
      // v2 additive-delta heat. The bot POSTs *_delta values; the ingest route
      // does `col = col + ?` (NEVER a bare .merge()) so accumulation is exact.
      t.integer('hits').notNullable().defaultTo(0);          // Σ times this mob was seen in the cell
      t.integer('passes').notNullable().defaultTo(0);        // Σ times the cell was traversed empty (denominator)
      t.integer('instance_sum').notNullable().defaultTo(0);  // Σ concurrent instances → typical group size
      t.bigInteger('last_hit_run_id').defaultTo(0);          // last run whose hit delta was applied (distinct-runs)
      t.bigInteger('last_pass_run_id').defaultTo(0);         // last run whose pass delta was applied
      t.bigInteger('first_seen_sec').notNullable();
      t.bigInteger('last_seen_sec').notNullable();
      t.primary(['server_id', 'zone_no', 'mob_id', 'cell_x', 'cell_z', 'channel']);
      t.index(['server_id', 'zone_no'], 'idx_spawn_server_zone');
      t.index(['server_id', 'mob_id'], 'idx_spawn_server_mob');
    });
  }

  // ── zone_bounds ──────────────────────────────────────────────────────────
  // [B2] persisted per-zone bounds/origin. Populated from the export
  // calibration sidecar [B3]. Until the first export exists ingest validation
  // falls back to a loose world-bounds guess.
  if (!(await knex.schema.hasTable('zone_bounds'))) {
    await knex.schema.createTable('zone_bounds', (t) => {
      t.integer('server_id').unsigned().notNullable();
      t.integer('zone_no').notNullable();
      t.float('origin_x').notNullable();          // quantization origin [B1]
      t.float('origin_z').notNullable();
      t.float('world_min_x').notNullable();       // framing extents [B3]
      t.float('world_min_z').notNullable();
      t.float('world_max_x').notNullable();
      t.float('world_max_z').notNullable();
      t.integer('size_px').nullable();            // exported PNG side length
      t.float('meters_per_pixel').nullable();
      t.float('cell_size_m').notNullable().defaultTo(4); // fixed 4 m [B1]
      t.bigInteger('updated_at').notNullable();
      t.primary(['server_id', 'zone_no']);
    });
  }

  // ── issued_ingest_tokens ─────────────────────────────────────────────────
  // §3.9 — panel-minted scope:'ingest' tokens. A row here is REQUIRED for a
  // scope==='ingest' token to validate (revoked=false AND expires_at>now).
  // Per-token revoke = flip `revoked`.
  if (!(await knex.schema.hasTable('issued_ingest_tokens'))) {
    await knex.schema.createTable('issued_ingest_tokens', (t) => {
      t.string('jti', 32).primary();              // random 32-hex token id (matches ed25519 generateJti)
      t.integer('user_id').unsigned().nullable(); // owning user (from the license)
      t.string('license_key', 32).nullable();     // the license the token is minted against
      t.string('scope', 24).notNullable().defaultTo('ingest');
      t.boolean('revoked').notNullable().defaultTo(false);
      t.bigInteger('expires_at').notNullable();   // unix seconds; must match token exp
      t.bigInteger('created_at').notNullable();
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Reverse creation order.
  if (await knex.schema.hasTable('issued_ingest_tokens')) {
    await knex.schema.dropTable('issued_ingest_tokens');
  }
  if (await knex.schema.hasTable('zone_bounds')) {
    await knex.schema.dropTable('zone_bounds');
  }
  if (await knex.schema.hasTable('mob_spawn_cells')) {
    await knex.schema.dropTable('mob_spawn_cells');
  }
  if (await knex.schema.hasTable('mob_catalog')) {
    await knex.schema.dropTable('mob_catalog');
  }
  if (await knex.schema.hasTable('game_servers')) {
    await knex.schema.dropTable('game_servers');
  }
}
