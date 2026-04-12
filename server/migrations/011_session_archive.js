/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('bot_sessions', (t) => {
    t.boolean('active').notNullable().defaultTo(true).index();
    t.integer('ended_at').unsigned().nullable();
    t.string('end_reason', 32).nullable(); // 'heartbeat_timeout', 'user_end', 'admin_kill', 'user_kill', 'hwid_reset'
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('bot_sessions', (t) => {
    t.dropColumn('active');
    t.dropColumn('ended_at');
    t.dropColumn('end_reason');
  });
}
