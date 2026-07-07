//
// 031_zone_maps.js
//
// Per-(server, zone) BACKGROUND MAP IMAGE metadata. STRICTLY ADDITIVE on top
// of 030: not one existing table/column is touched. The image BYTES live on
// disk (Releases-style filesystem storage under BOT_PRIVATE_DIR); this table
// carries only the path/meta row so the admin panel can list coverage and the
// portal serve route can stream the right file.
//
//   zone_maps — one row per (server_id, zone_no) [PK]. A row exists iff a
//               background image is uploaded for that (server, zone). The user
//               MonsterMap renders this image UNDER the spawn points, framed by
//               zone_bounds (the bot's export frames the exact zone AABB, so an
//               uploaded bot-export aligns pixel-accurately).
//
//     format        — 'svg' | 'png' (which of the two accepted formats).
//     file_name     — the stored disk filename (deterministic, no user path).
//     orig_name     — the client-supplied original filename (display only).
//     content_type  — 'image/svg+xml' | 'image/png' (served verbatim).
//     byte_size     — bytes on disk.
//     width/height  — pixel dimensions when known (PNG header / SVG viewBox),
//                     NULL when not parseable.
//     uploaded_by   — admin user id (NULL if the user row is later removed).
//     uploaded_at   — unix seconds.
//
// Create is hasTable-guarded; down() drops it. No existing table is touched.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (!(await knex.schema.hasTable('zone_maps'))) {
    await knex.schema.createTable('zone_maps', (t) => {
      t.integer('server_id').unsigned().notNullable();
      t.integer('zone_no').notNullable();
      t.string('format', 8).notNullable();          // 'svg' | 'png'
      t.string('file_name', 255).notNullable();     // stored disk filename (deterministic)
      t.string('orig_name', 255).nullable();        // client-supplied original name (display only)
      t.string('content_type', 64).notNullable();   // 'image/svg+xml' | 'image/png'
      t.integer('byte_size').notNullable();
      t.integer('width').nullable();                // px when parseable, else NULL
      t.integer('height').nullable();
      t.integer('uploaded_by').unsigned().nullable();
      t.bigInteger('uploaded_at').notNullable();    // unix seconds
      t.primary(['server_id', 'zone_no']);
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  if (await knex.schema.hasTable('zone_maps')) {
    await knex.schema.dropTable('zone_maps');
  }
}
