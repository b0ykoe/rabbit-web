//
// 046_drop_offset_overrides.js
//
// TEARDOWN of the signed OFFSET-OVERRIDE subsystem (migrations 038–041).
//
// The bot now HARD-CODES every offset in the compiled variant
// (engine_variant_*.{h,cpp}); the panel-signed / web-fetched override path is
// permanently disabled bot-side (kOffsetOverridesEnabled = false). The portal's
// offset routes, crypto and admin UI are removed in the same change, so these
// tables + game_servers columns are now dead. This migration drops them.
//
// SCOPE — drops ONLY the offset subsystem:
//   tables : server_build_overrides, server_builds, template_field_values,
//            build_templates, server_offset_overrides, offset_field_catalog,
//            offset_signing_keys
//   game_servers columns : engine_time_date_stamp, engine_size_of_image,
//            offset_signed_blob, offset_signed_at, offset_template_id
//
// DOES NOT TOUCH the SHARED Ed25519 token/release key or its outputs:
//   - server/src/crypto/ed25519.js, env BOT_ED25519_PRIVATE_KEY/PUBLIC_KEY
//   - releases.dll_signature (migration 018 — release DLL signing)
//   - the game_servers TABLE itself (only its 5 offset columns are dropped)
// The offset signing key (offset_signing_keys) is a SEPARATE key from the bot
// token/release key and is safe to drop.
//
// ⚠️ IRREVERSIBLE DATA LOSS. This permanently deletes:
//   - offset_signing_keys.enc_private_key — the ONLY copy of the offset Ed25519
//     signing private key (never stored in any env var / backup by design).
//   - all per-server / per-build offset overrides, build templates and the field
//     catalog.
//   BACK UP these tables before running `npm run migrate` if there is any chance
//   the feature will be revived. down() only restores the EMPTY schema — it
//   CANNOT restore any row.
//
// DDL only — `transaction: false` (MySQL implicit-commits DDL; a DDL migration
// inside a transaction trips the migration lock — mirrors 038–041).
//

export const config = { transaction: false };

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── Drop the offset tables (guarded; child/override tables first) ───────────
  for (const tbl of [
    'server_build_overrides',
    'server_builds',
    'template_field_values',
    'build_templates',
    'server_offset_overrides',
    'offset_field_catalog',
    'offset_signing_keys',
  ]) {
    if (await knex.schema.hasTable(tbl)) {
      await knex.schema.dropTable(tbl);
    }
  }

  // ── Drop the game_servers offset columns (guarded; keep the table) ──────────
  if (await knex.schema.hasTable('game_servers')) {
    for (const col of [
      'engine_time_date_stamp',
      'engine_size_of_image',
      'offset_signed_blob',
      'offset_signed_at',
      'offset_template_id',
    ]) {
      if (await knex.schema.hasColumn('game_servers', col)) {
        await knex.schema.alterTable('game_servers', (t) => {
          t.dropColumn(col);
        });
      }
    }
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Recreates the EMPTY schema of 038–041 so `migrate:rollback` is clean.
  // ⚠️ DATA IS NOT RESTORED — the offset overrides, templates and (critically) the
  // offset signing private key are gone. To truly revive the feature, restore the
  // dropped tables from a backup, not via this rollback.

  // 038 — offset_field_catalog / server_offset_overrides / offset_signing_keys
  if (!(await knex.schema.hasTable('offset_field_catalog'))) {
    await knex.schema.createTable('offset_field_catalog', (t) => {
      t.string('field_name', 64).notNullable().primary();
      t.string('kind', 8).notNullable();
      t.string('criticality', 16).nullable();
      t.bigInteger('base_value').nullable();
      t.bigInteger('updated_at').notNullable();
      t.string('base_text', 255).nullable();          // 041
    });
  }
  if (!(await knex.schema.hasTable('server_offset_overrides'))) {
    await knex.schema.createTable('server_offset_overrides', (t) => {
      t.integer('server_id').unsigned().notNullable();
      t.string('field_name', 64).notNullable();
      t.bigInteger('value').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['server_id', 'field_name']);
      t.string('value_text', 255).nullable();         // 041
    });
  }
  if (!(await knex.schema.hasTable('offset_signing_keys'))) {
    await knex.schema.createTable('offset_signing_keys', (t) => {
      t.integer('id').unsigned().notNullable().primary();
      t.string('public_key_hex', 64).notNullable();
      t.text('enc_private_key').notNullable();
      t.bigInteger('created_at').notNullable();
    });
  }

  // 039 — build_templates / template_field_values
  if (!(await knex.schema.hasTable('build_templates'))) {
    await knex.schema.createTable('build_templates', (t) => {
      t.increments('id').primary();
      t.string('name', 64).notNullable().unique();
      t.string('notes', 255).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('template_field_values'))) {
    await knex.schema.createTable('template_field_values', (t) => {
      t.integer('template_id').unsigned().notNullable();
      t.string('field_name', 64).notNullable();
      t.bigInteger('value').notNullable();
      t.primary(['template_id', 'field_name']);
      t.string('value_text', 255).nullable();         // 041
    });
  }

  // 040 — server_builds / server_build_overrides
  if (!(await knex.schema.hasTable('server_builds'))) {
    await knex.schema.createTable('server_builds', (t) => {
      t.increments('id').primary();
      t.integer('server_id').unsigned().notNullable();
      t.bigInteger('stamp').notNullable();
      t.bigInteger('size').notNullable();
      t.string('label', 64).nullable();
      t.mediumtext('signed_blob').nullable();
      t.bigInteger('signed_at').nullable();
      t.bigInteger('created_at').nullable();
      t.bigInteger('updated_at').nullable();
      t.unique(['server_id', 'stamp']);
    });
  }
  if (!(await knex.schema.hasTable('server_build_overrides'))) {
    await knex.schema.createTable('server_build_overrides', (t) => {
      t.integer('server_build_id').unsigned().notNullable();
      t.string('field_name', 64).notNullable();
      t.bigInteger('value').notNullable();
      t.bigInteger('updated_at').nullable();
      t.primary(['server_build_id', 'field_name']);
      t.string('value_text', 255).nullable();         // 041
    });
  }

  // 038 + 039 — game_servers offset columns
  if (await knex.schema.hasTable('game_servers')) {
    if (!(await knex.schema.hasColumn('game_servers', 'engine_time_date_stamp'))) {
      await knex.schema.alterTable('game_servers', (t) => { t.bigInteger('engine_time_date_stamp').nullable(); });
    }
    if (!(await knex.schema.hasColumn('game_servers', 'engine_size_of_image'))) {
      await knex.schema.alterTable('game_servers', (t) => { t.bigInteger('engine_size_of_image').nullable(); });
    }
    if (!(await knex.schema.hasColumn('game_servers', 'offset_signed_blob'))) {
      await knex.schema.alterTable('game_servers', (t) => { t.mediumtext('offset_signed_blob').nullable(); });
    }
    if (!(await knex.schema.hasColumn('game_servers', 'offset_signed_at'))) {
      await knex.schema.alterTable('game_servers', (t) => { t.bigInteger('offset_signed_at').nullable(); });
    }
    if (!(await knex.schema.hasColumn('game_servers', 'offset_template_id'))) {
      await knex.schema.alterTable('game_servers', (t) => { t.integer('offset_template_id').unsigned().nullable(); });
    }
  }
}
