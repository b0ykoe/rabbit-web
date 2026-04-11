/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // Global status banners (admin-managed, shown in portal)
  if (!(await knex.schema.hasTable('global_statuses'))) {
    await knex.schema.createTable('global_statuses', (t) => {
      t.increments('id');
      t.string('message', 500).notNullable();
      t.enum('color', ['info', 'warning', 'error', 'success']).notNullable().defaultTo('info');
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);
    });
  }

  // Last login timestamp
  if (!(await knex.schema.hasColumn('users', 'last_login_at'))) {
    await knex.schema.alterTable('users', (t) => {
      t.timestamp('last_login_at').nullable().after('hwid_reset_enabled');
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('global_statuses');
  if (await knex.schema.hasColumn('users', 'last_login_at')) {
    await knex.schema.alterTable('users', (t) => { t.dropColumn('last_login_at'); });
  }
}
