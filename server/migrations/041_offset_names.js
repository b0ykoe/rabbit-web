//
// 041_offset_names.js
//
// The STRING (mangled Engine.dll export NAME) dimension of the signed offset
// system (P5), fully PARALLEL to the numeric offset/VA model and STRICTLY
// ADDITIVE. Beyond numeric offsets/VAs a build that RENAMES or MOVES an exported
// symbol must be fixable from the panel, so every layer of the numeric stack
// gains a nullable STRING sibling column carrying the mangled symbol name.
// Nemesis mangles names DIFFERENTLY from Stock, so names need per-server /
// per-build overrides exactly like numeric values.
//
//   offset_field_catalog.base_text     — the Stock base mangled name for a
//                                        kind:"name" slot (VARCHAR(255) NULL).
//                                        NULL for numeric (data|va) slots.
//   template_field_values.value_text   — a build template's base name for a slot
//                                        (VARCHAR(255) NULL); parallel to `value`.
//   server_offset_overrides.value_text — a server's GENERAL name override
//                                        (VARCHAR(255) NULL); parallel to `value`.
//   server_build_overrides.value_text  — a build's PER-BUILD name override
//                                        (VARCHAR(255) NULL); parallel to `value`.
//
// Effective name for a slot = build.value_text ?? general.value_text ??
//   template.value_text ?? catalog.base_text — the exact precedence chain the
// numeric side uses, one layer per table. The signed payload gains a parallel
// `names` object alongside `fields`; old bots ignore the new key.
//
// Every ADD/DROP COLUMN is hasColumn-guarded (re-run = no-op); down() drops the
// four columns guarded the same way. No existing column is altered, no data
// touched. DDL only — NO transaction (mixing DDL with a transaction trips
// MySQL implicit-commit; mirrors migrations 038/039/040).
//

export const config = { transaction: false };

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── offset_field_catalog.base_text ───────────────────────────────────────────
  if (await knex.schema.hasTable('offset_field_catalog')) {
    if (!(await knex.schema.hasColumn('offset_field_catalog', 'base_text'))) {
      await knex.schema.alterTable('offset_field_catalog', (t) => {
        t.string('base_text', 255).nullable();   // Stock base mangled name (name slots)
      });
    }
  }

  // ── template_field_values.value_text ─────────────────────────────────────────
  if (await knex.schema.hasTable('template_field_values')) {
    if (!(await knex.schema.hasColumn('template_field_values', 'value_text'))) {
      await knex.schema.alterTable('template_field_values', (t) => {
        t.string('value_text', 255).nullable();  // template base name (parallel to value)
      });
    }
  }

  // ── server_offset_overrides.value_text ───────────────────────────────────────
  if (await knex.schema.hasTable('server_offset_overrides')) {
    if (!(await knex.schema.hasColumn('server_offset_overrides', 'value_text'))) {
      await knex.schema.alterTable('server_offset_overrides', (t) => {
        t.string('value_text', 255).nullable();  // general name override (parallel to value)
      });
    }
  }

  // ── server_build_overrides.value_text ────────────────────────────────────────
  if (await knex.schema.hasTable('server_build_overrides')) {
    if (!(await knex.schema.hasColumn('server_build_overrides', 'value_text'))) {
      await knex.schema.alterTable('server_build_overrides', (t) => {
        t.string('value_text', 255).nullable();  // per-build name override (parallel to value)
      });
    }
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const drops = [
    ['server_build_overrides',  'value_text'],
    ['server_offset_overrides', 'value_text'],
    ['template_field_values',   'value_text'],
    ['offset_field_catalog',    'base_text'],
  ];
  for (const [tbl, col] of drops) {
    if (await knex.schema.hasTable(tbl)) {
      if (await knex.schema.hasColumn(tbl, col)) {
        await knex.schema.alterTable(tbl, (t) => {
          t.dropColumn(col);
        });
      }
    }
  }
}
