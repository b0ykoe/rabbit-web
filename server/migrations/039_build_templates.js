//
// 039_build_templates.js
//
// BUILD TEMPLATES (Phase 1 of the "everything in the panel" model). A build
// template is a named, per-edition set of BASE field values (Stock EP4, Stock EP2,
// …). A game server FORKS one template (game_servers.offset_template_id) and stores
// only its own field deltas in server_offset_overrides (038). Effective value for a
// server field = its override, else the template's base value.
//
// This supersedes offset_field_catalog.base_value as the source of base values:
// the catalog (038) stays as the global FIELD UNIVERSE (name + kind + criticality),
// while the actual base NUMBERS move onto templates so several editions can coexist.
//
//   build_templates          — one row per edition/base.
//       id          INT UNSIGNED PK AUTO_INCREMENT
//       name        VARCHAR(64)  NOT NULL UNIQUE   e.g. 'Stock EP4'
//       notes       VARCHAR(255) NULL
//       created_at  BIGINT       NOT NULL
//       updated_at  BIGINT       NOT NULL
//
//   template_field_values    — per-template base value for a catalog field.
//       template_id INT UNSIGNED NOT NULL
//       field_name  VARCHAR(64)  NOT NULL
//       value       BIGINT       NOT NULL
//       PRIMARY KEY(template_id, field_name)
//
//   game_servers.offset_template_id INT UNSIGNED NULL — which template the server forks.
//
// SEED: if a catalog was already imported (038), fold its base_value into a starting
// "Stock EP4" template so the existing import is not lost. Idempotent (only seeds
// when build_templates is empty).
//
// DDL only (+ one seed) — no transaction (mixing DDL with a transaction trips
// MySQL implicit-commit; mirrors migration 034/037).
//

export const config = { transaction: false };

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── build_templates ────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('build_templates'))) {
    await knex.schema.createTable('build_templates', (t) => {
      t.increments('id').primary();
      t.string('name', 64).notNullable().unique();
      t.string('notes', 255).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
    });
  }

  // ── template_field_values ──────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('template_field_values'))) {
    await knex.schema.createTable('template_field_values', (t) => {
      t.integer('template_id').unsigned().notNullable();
      t.string('field_name', 64).notNullable();
      t.bigInteger('value').notNullable();
      t.primary(['template_id', 'field_name']);
    });
  }

  // ── game_servers.offset_template_id (guarded add) ─────────────────────────
  if (await knex.schema.hasTable('game_servers')) {
    if (!(await knex.schema.hasColumn('game_servers', 'offset_template_id'))) {
      await knex.schema.alterTable('game_servers', (t) => {
        t.integer('offset_template_id').unsigned().nullable();
      });
    }
  }

  // ── SEED: fold an already-imported catalog into a "Stock EP4" template ──────
  // Only when there are no templates yet AND a catalog with base values exists.
  const templateCount = await knex('build_templates').count({ c: '*' }).first();
  const haveTemplates = templateCount && Number(templateCount.c) > 0;
  if (!haveTemplates && (await knex.schema.hasTable('offset_field_catalog'))) {
    const baseRows = await knex('offset_field_catalog')
      .whereNotNull('base_value')
      .select('field_name', 'base_value');
    if (baseRows.length) {
      const now = Math.floor(Date.now() / 1000);
      const [templateId] = await knex('build_templates').insert({
        name: 'Stock EP4',
        notes: 'Seeded from the first imported offset catalog.',
        created_at: now,
        updated_at: now,
      });
      await knex('template_field_values').insert(
        baseRows.map((r) => ({
          template_id: templateId,
          field_name:  r.field_name,
          value:       r.base_value,
        })),
      );
    }
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  if (await knex.schema.hasTable('game_servers')) {
    if (await knex.schema.hasColumn('game_servers', 'offset_template_id')) {
      await knex.schema.alterTable('game_servers', (t) => {
        t.dropColumn('offset_template_id');
      });
    }
  }
  for (const tbl of ['template_field_values', 'build_templates']) {
    if (await knex.schema.hasTable(tbl)) {
      await knex.schema.dropTable(tbl);
    }
  }
}
