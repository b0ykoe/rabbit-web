/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (await knex.schema.hasTable('licenses')) return;
  await knex.schema.createTable('licenses', (t) => {
    t.string('license_key', 32).primary();
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('max_sessions').unsigned().notNullable().defaultTo(1);
    t.boolean('active').notNullable().defaultTo(true);
    t.string('note', 255).nullable();
    t.timestamps(true, true);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('licenses');
}
