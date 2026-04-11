/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const hasStartsAt = await knex.schema.hasColumn('global_statuses', 'starts_at');
  if (!hasStartsAt) {
    await knex.schema.alterTable('global_statuses', (t) => {
      t.timestamp('starts_at').nullable().after('active');   // null = starts immediately
      t.timestamp('ends_at').nullable().after('starts_at');  // null = no end (lifetime/manual)
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('global_statuses', (t) => {
    t.dropColumn('starts_at');
    t.dropColumn('ends_at');
  });
}
