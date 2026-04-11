/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (await knex.schema.hasTable('releases')) return;
  await knex.schema.createTable('releases', (t) => {
    t.increments('id');
    t.enum('type', ['dll', 'loader']).notNullable();
    t.string('version', 32).notNullable();
    t.string('file_path', 500).notNullable();
    t.string('sha256', 64).notNullable();
    t.text('changelog').notNullable();
    t.boolean('active').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.unique(['type', 'version']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('releases');
}
