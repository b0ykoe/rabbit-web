//
// 038_offset_overrides.js
//
// OFFSET-OVERRIDE system (Phase D — server side). Model: the bot ships a single
// compiled "Stock EP4" base GameLayout; each game server is that base PLUS a few
// FIELD OVERRIDES, keyed to the target Engine.dll build (its PE TimeDateStamp +
// SizeOfImage). A super-admin edits the overrides, then SIGNS them with an
// Ed25519 key whose private half is stored ONLY password-encrypted at rest. The
// signed blob is served to authed bots; the signature is the tamper gate.
//
// This migration is STRICTLY ADDITIVE schema:
//
//   offset_field_catalog   — the bot-exported catalog of OVERRIDABLE GameLayout
//                            fields (replace-all imported from the bot).
//       field_name   VARCHAR(64)  PK       the GameLayout field key.
//       kind         VARCHAR(8)   NOT NULL 'data' | 'va'.
//       criticality  VARCHAR(16)  NULL     SlotCriticality label, if any.
//       base_value   BIGINT       NULL     the compiled Stock value, for display.
//       updated_at   BIGINT       NOT NULL epoch sec of last catalog import.
//
//   server_offset_overrides — the per-server field deltas off the base.
//       server_id    INT UNSIGNED NOT NULL
//       field_name   VARCHAR(64)  NOT NULL
//       value        BIGINT       NOT NULL the override value for this server.
//       updated_at   BIGINT       NOT NULL epoch sec of last edit.
//       PRIMARY KEY(server_id, field_name).
//
//   offset_signing_keys    — the single Ed25519 signing key (id always 1). The
//                            private half is NEVER stored in the clear.
//       id              INT UNSIGNED PK   always 1.
//       public_key_hex  VARCHAR(64)  NOT NULL  32-byte pubkey, hex.
//       enc_private_key TEXT         NOT NULL  b64( salt(16)|iv(12)|tag(16)|ct ),
//                                              aes-256-gcm, scrypt-wrapped by pwd.
//       created_at      BIGINT       NOT NULL  epoch sec at generation.
//
// Plus four guarded ALTERs on game_servers carrying the Engine fingerprint the
// overrides are keyed to, and the cached signed blob:
//       engine_time_date_stamp BIGINT     NULL  PE TimeDateStamp of the target dll.
//       engine_size_of_image   BIGINT     NULL  PE SizeOfImage of the target dll.
//       offset_signed_blob     MEDIUMTEXT NULL  JSON { payload_b64, signature_b64 }.
//       offset_signed_at       BIGINT     NULL  epoch sec the blob was signed.
//
// down() drops the three tables and the four game_servers columns (all guarded).
//
// OUT OF SCOPE (note for a later pass): these tables are NOT yet wired into the
// DELETE /servers cascade nor the merge re-point set in admin.world.js — a server
// delete/merge will orphan its server_offset_overrides + fingerprint/blob columns
// until that pass lands.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── offset_field_catalog ──────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('offset_field_catalog'))) {
    await knex.schema.createTable('offset_field_catalog', (t) => {
      t.string('field_name', 64).notNullable().primary();  // GameLayout field key
      t.string('kind', 8).notNullable();                   // 'data' | 'va'
      t.string('criticality', 16).nullable();              // SlotCriticality label
      t.bigInteger('base_value').nullable();               // compiled Stock value
      t.bigInteger('updated_at').notNullable();            // epoch sec of import
    });
  }

  // ── server_offset_overrides ───────────────────────────────────────────────
  if (!(await knex.schema.hasTable('server_offset_overrides'))) {
    await knex.schema.createTable('server_offset_overrides', (t) => {
      t.integer('server_id').unsigned().notNullable();
      t.string('field_name', 64).notNullable();
      t.bigInteger('value').notNullable();                 // per-server override
      t.bigInteger('updated_at').notNullable();            // epoch sec of last edit
      t.primary(['server_id', 'field_name']);
    });
  }

  // ── offset_signing_keys ───────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('offset_signing_keys'))) {
    await knex.schema.createTable('offset_signing_keys', (t) => {
      t.integer('id').unsigned().notNullable().primary();  // always 1
      t.string('public_key_hex', 64).notNullable();        // 32-byte pubkey, hex
      t.text('enc_private_key').notNullable();             // b64(salt|iv|tag|ct)
      t.bigInteger('created_at').notNullable();            // epoch sec at generation
    });
  }

  // ── game_servers fingerprint + signed-blob columns (guarded adds) ─────────
  if (await knex.schema.hasTable('game_servers')) {
    if (!(await knex.schema.hasColumn('game_servers', 'engine_time_date_stamp'))) {
      await knex.schema.alterTable('game_servers', (t) => {
        t.bigInteger('engine_time_date_stamp').nullable(); // PE TimeDateStamp
      });
    }
    if (!(await knex.schema.hasColumn('game_servers', 'engine_size_of_image'))) {
      await knex.schema.alterTable('game_servers', (t) => {
        t.bigInteger('engine_size_of_image').nullable();   // PE SizeOfImage
      });
    }
    if (!(await knex.schema.hasColumn('game_servers', 'offset_signed_blob'))) {
      await knex.schema.alterTable('game_servers', (t) => {
        t.mediumtext('offset_signed_blob').nullable(); // { payload_b64, signature_b64 }
      });
    }
    if (!(await knex.schema.hasColumn('game_servers', 'offset_signed_at'))) {
      await knex.schema.alterTable('game_servers', (t) => {
        t.bigInteger('offset_signed_at').nullable();       // epoch sec signed
      });
    }
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Drop the four game_servers columns (guarded).
  if (await knex.schema.hasTable('game_servers')) {
    for (const col of [
      'engine_time_date_stamp',
      'engine_size_of_image',
      'offset_signed_blob',
      'offset_signed_at',
    ]) {
      if (await knex.schema.hasColumn('game_servers', col)) {
        await knex.schema.alterTable('game_servers', (t) => {
          t.dropColumn(col);
        });
      }
    }
  }

  // Drop the three tables (guarded).
  for (const tbl of [
    'server_offset_overrides',
    'offset_field_catalog',
    'offset_signing_keys',
  ]) {
    if (await knex.schema.hasTable(tbl)) {
      await knex.schema.dropTable(tbl);
    }
  }
}
