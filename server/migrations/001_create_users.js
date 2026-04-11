/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (await knex.schema.hasTable('users')) return;
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('email').notNullable().unique();
    t.string('password').notNullable();
    t.enum('role', ['admin', 'user']).notNullable().defaultTo('user');
    t.boolean('force_password_change').notNullable().defaultTo(false);
    t.string('remember_token', 100).nullable();
    t.timestamps(true, true); // created_at, updated_at
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('users');
}
