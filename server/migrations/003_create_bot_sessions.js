/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (await knex.schema.hasTable('bot_sessions')) return;
  await knex.schema.createTable('bot_sessions', (t) => {
    t.string('session_id', 64).primary();
    t.string('license_key', 32).notNullable().index();
    t.integer('started_at').unsigned().notNullable();
    t.integer('last_heartbeat').unsigned().notNullable();
    // No timestamps — uses integer unix timestamps
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('bot_sessions');
}
