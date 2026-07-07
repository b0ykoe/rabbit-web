//
// 032_spawn_version_recorder.js
//
// Record WHICH user first opened a spawn version (scan session). STRICTLY
// ADDITIVE on top of 031: not one existing table/column is touched. Adds a
// single NULLABLE column `user_id` to spawn_version_meta plus a covering index
// (user_id, ver_end_sec) so the admin "who recorded this / recent-by-user"
// reads stay index-served.
//
//   spawn_version_meta.user_id  — the RESOLVED ingest user_id (from the license,
//                                 NEVER a client body field) stamped ON INSERT
//                                 ONLY, i.e. first-writer-wins recorder. A row
//                                 that predates this migration, or a version
//                                 whose first ingest predates it, stays NULL.
//                                 INT UNSIGNED NULL to mirror users.id /
//                                 game_servers.server_id unsigned convention.
//
//   idx_spawn_ver_meta_user     — (user_id, ver_end_sec) supports "versions this
//                                 user recorded, newest window first" without a
//                                 full scan of spawn_version_meta.
//
// Both the add-column and add-index are hasColumn-guarded so a re-run is a
// no-op; down() reverses (drop index, then drop column) guarded the same way.
// No existing column is altered.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (await knex.schema.hasTable('spawn_version_meta')) {
    if (!(await knex.schema.hasColumn('spawn_version_meta', 'user_id'))) {
      await knex.schema.alterTable('spawn_version_meta', (t) => {
        // Nullable recorder id; first-writer-wins (stamped on INSERT only).
        t.integer('user_id').unsigned().nullable();
        // "versions a user recorded, newest window first."
        t.index(['user_id', 'ver_end_sec'], 'idx_spawn_ver_meta_user');
      });
    }
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  if (await knex.schema.hasTable('spawn_version_meta')) {
    if (await knex.schema.hasColumn('spawn_version_meta', 'user_id')) {
      await knex.schema.alterTable('spawn_version_meta', (t) => {
        t.dropIndex(['user_id', 'ver_end_sec'], 'idx_spawn_ver_meta_user');
        t.dropColumn('user_id');
      });
    }
  }
}
