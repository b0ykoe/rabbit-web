//
// 037_game_variants.js
//
// GAME VARIANT registry (Phase C — LABEL layer only). Today game_servers.variant
// is a free-text VARCHAR(32) that the bot EMITS and the portal JOINs on; the
// picker list is a hardcoded const in the client. This migration promotes each
// distinct variant string to a MANAGED row so a super-admin can name/describe/
// archive variants from the admin panel and add new ones without a code change.
//
// The variant STRING stays the join key — game_variants.name mirrors
// game_servers.variant EXACTLY. There is deliberately NO foreign key: a bot can
// report a never-seen variant first (ingest self-registers it), so a hard FK
// would reject a legitimate first sighting. This layer carries LABELS only — the
// per-server OFFSET overrides come in later phases (D/E/F), not here.
//
//   game_variants          — one row per distinct variant string.
//       id           INT UNSIGNED  PK auto-increment.
//       name         VARCHAR(32)   NOT NULL UNIQUE   join key = game_servers.variant.
//       display_name VARCHAR(64)   NULL              admin-facing pretty name.
//       notes        VARCHAR(255)  NULL              free-form admin notes.
//       archived     BOOLEAN       NOT NULL default false  hidden from pickers.
//       created_at   BIGINT        NULL              epoch sec at first register.
//       updated_at   BIGINT        NULL              epoch sec at last edit.
//
// The create is hasTable-guarded so a re-run is a no-op. up() then SEEDS the
// table: a row for every DISTINCT game_servers.variant currently present PLUS
// the legacy trio (Nemesis, "EP4 Stock", Unknown), each inserted only when the
// name is not already present (hasRow guard = ON-conflict-ignore). down() drops
// game_variants (guarded). STRICTLY ADDITIVE — no existing table is altered.
//

// Legacy variants that must always exist in the picker even on a fresh DB with
// no servers yet. Mirrors the hardcoded client fallback trio.
const LEGACY_VARIANTS = ['Nemesis', 'EP4 Stock', 'Unknown'];

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── game_variants ─────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('game_variants'))) {
    await knex.schema.createTable('game_variants', (t) => {
      t.increments('id').primary();
      t.string('name', 32).notNullable();                // join key = servers.variant
      t.string('display_name', 64).nullable();           // admin-facing pretty name
      t.string('notes', 255).nullable();                 // free-form admin notes
      t.boolean('archived').notNullable().defaultTo(false);
      t.bigInteger('created_at').nullable();
      t.bigInteger('updated_at').nullable();
      t.unique(['name']);                                // one row per variant string
    });
  }

  // ── Seed: DISTINCT game_servers.variant ∪ the legacy trio ─────────────────
  // Collect every variant string that must exist: the distinct set currently in
  // use PLUS the legacy trio. Each is inserted only when its name is not already
  // present, so a re-run (or an already-seeded row) is a no-op.
  const now = Math.floor(Date.now() / 1000);

  const seedNames = new Set(LEGACY_VARIANTS.map((v) => v.trim()).filter(Boolean));
  if (await knex.schema.hasTable('game_servers')) {
    const rows = await knex('game_servers')
      .whereNotNull('variant')
      .distinct('variant')
      .pluck('variant');
    for (const v of rows) {
      const name = (v || '').trim();
      if (name) seedNames.add(name);
    }
  }

  for (const name of seedNames) {
    const exists = await knex('game_variants').where('name', name).select('id').first();
    if (exists) continue;
    await knex('game_variants').insert({
      name,
      display_name: null,
      notes:        null,
      archived:     false,
      created_at:   now,
      updated_at:   now,
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Reverse: drop game_variants.
  if (await knex.schema.hasTable('game_variants')) {
    await knex.schema.dropTable('game_variants');
  }
}
