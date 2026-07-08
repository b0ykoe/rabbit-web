//
// 040_server_builds.js
//
// PER-BUILD offset overrides + per-build signed blobs (P4 — the per-patch tier).
// Mirrors the bot's engine_variant_nemesis.cpp: a server has a GENERAL override
// layer (server_offset_overrides, 038) forked off a build TEMPLATE (039), and now
// ALSO a PER-BUILD (per Engine.dll stamp) override layer keyed PER-SERVER + stamp.
//
// EFFECTIVE value for a bot on (server S, Engine stamp X) =
//   per_build_override[S,X][field] ?? server_general_override[S][field] ?? template_base[field]
// (precedence: per-build > general > template). Each build carries its OWN signed
// blob whose payload {v,server_id,stamp,size,fields} holds that merged effective
// set + the BUILD's stamp/size. The bot fetches the blob matching ITS stamp; an
// old bot that sends no stamp still gets the server-level blob (038) — additive +
// backward-compatible.
//
//   server_builds            — one row per (server, Engine.dll stamp).
//       id          INT UNSIGNED PK AUTO_INCREMENT
//       server_id   INT UNSIGNED NOT NULL   the owning game_servers.id
//       stamp       BIGINT       NOT NULL   PE TimeDateStamp of the target dll
//       size        BIGINT       NOT NULL   PE SizeOfImage of the target dll
//       label       VARCHAR(64)  NULL       optional human label
//       signed_blob MEDIUMTEXT   NULL       JSON { payload_b64, signature_b64 }
//       signed_at   BIGINT       NULL       epoch sec the blob was signed
//       created_at  BIGINT       NULL
//       updated_at  BIGINT       NULL
//       UNIQUE(server_id, stamp).
//
//   server_build_overrides   — per-build field deltas (over the general layer).
//       server_build_id INT UNSIGNED NOT NULL   the owning server_builds.id
//       field_name      VARCHAR(64)  NOT NULL
//       value           BIGINT       NOT NULL    the per-build override value
//       updated_at      BIGINT       NULL        epoch sec of last edit
//       PRIMARY KEY(server_build_id, field_name).
//
// down() drops both tables (guarded). No change to existing tables.
//
// DDL only — no transaction (mixing DDL with a transaction trips MySQL
// implicit-commit; mirrors migration 038/039).
//

export const config = { transaction: false };

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── server_builds ──────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('server_builds'))) {
    await knex.schema.createTable('server_builds', (t) => {
      t.increments('id').primary();
      t.integer('server_id').unsigned().notNullable();
      t.bigInteger('stamp').notNullable();                 // PE TimeDateStamp
      t.bigInteger('size').notNullable();                  // PE SizeOfImage
      t.string('label', 64).nullable();
      t.mediumtext('signed_blob').nullable();              // { payload_b64, signature_b64 }
      t.bigInteger('signed_at').nullable();                // epoch sec signed
      t.bigInteger('created_at').nullable();
      t.bigInteger('updated_at').nullable();
      t.unique(['server_id', 'stamp']);
    });
  }

  // ── server_build_overrides ─────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('server_build_overrides'))) {
    await knex.schema.createTable('server_build_overrides', (t) => {
      t.integer('server_build_id').unsigned().notNullable();
      t.string('field_name', 64).notNullable();
      t.bigInteger('value').notNullable();                 // per-build override
      t.bigInteger('updated_at').nullable();               // epoch sec of last edit
      t.primary(['server_build_id', 'field_name']);
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  for (const tbl of ['server_build_overrides', 'server_builds']) {
    if (await knex.schema.hasTable(tbl)) {
      await knex.schema.dropTable(tbl);
    }
  }
}
