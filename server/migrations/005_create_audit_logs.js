/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (await knex.schema.hasTable('audit_logs')) return;
  await knex.schema.createTable('audit_logs', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('action', 64).notNullable();
    t.string('subject_type', 64).nullable();
    t.string('subject_id', 64).nullable();
    t.json('old_values').nullable();
    t.json('new_values').nullable();
    t.string('ip_address', 45).nullable();
    t.string('user_agent', 255).nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    // No updated_at — audit logs are immutable
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('audit_logs');
}
