// Published MapViewer navigation caches, grouped by the admin-defined game
// server. A package is replaced atomically; its file rows form the immutable
// manifest consumed by the loader.

export const config = { transaction: false };

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (!(await knex.schema.hasTable('navigation_cache_packages'))) {
    await knex.schema.createTable('navigation_cache_packages', (t) => {
      t.increments('id').primary();
      t.integer('server_id').unsigned().notNullable().unique()
        .references('id').inTable('game_servers').onDelete('CASCADE');
      t.integer('schema_version').unsigned().notNullable();
      t.integer('file_count').unsigned().notNullable();
      t.bigInteger('total_bytes').unsigned().notNullable();
      t.string('storage_key', 96).notNullable().unique();
      t.string('manifest_sha256', 64).notNullable();
      t.integer('uploaded_by').unsigned().nullable()
        .references('id').inTable('users').onDelete('SET NULL');
      t.timestamp('uploaded_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable('navigation_cache_files'))) {
    await knex.schema.createTable('navigation_cache_files', (t) => {
      t.increments('id').primary();
      t.integer('package_id').unsigned().notNullable()
        .references('id').inTable('navigation_cache_packages').onDelete('CASCADE');
      t.integer('zone_no').unsigned().notNullable();
      t.string('file_name', 128).notNullable();
      t.bigInteger('byte_size').unsigned().notNullable();
      t.string('sha256', 64).notNullable();
      t.string('source_fingerprint', 64).notNullable();
      t.unique(['package_id', 'file_name']);
      t.index(['package_id', 'zone_no']);
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('navigation_cache_files');
  await knex.schema.dropTableIfExists('navigation_cache_packages');
}
