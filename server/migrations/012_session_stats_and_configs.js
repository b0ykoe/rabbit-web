/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // Add stats snapshot to bot_sessions
  await knex.schema.alterTable('bot_sessions', (t) => {
    t.text('stats_json').nullable(); // JSON: {kills, xp_earned, items_looted, skills_used, deaths, stuck_escapes, runtime_ms}
  });

  // Server-side config storage (per user + character)
  if (!(await knex.schema.hasTable('bot_configs'))) {
    await knex.schema.createTable('bot_configs', (t) => {
      t.increments('id').primary();
      t.integer('user_id').unsigned().notNullable()
        .references('id').inTable('users').onDelete('CASCADE');
      t.string('char_name', 64).notNullable();
      t.mediumtext('config_json').notNullable();
      t.timestamps(true, true);
      t.unique(['user_id', 'char_name']);
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('bot_configs');
  await knex.schema.alterTable('bot_sessions', (t) => {
    t.dropColumn('stats_json');
  });
}
