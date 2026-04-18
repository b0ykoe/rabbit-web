/**
 * Extend the `users.role` enum from ['admin', 'user'] to ['super_admin',
 * 'admin', 'user']. Super-admin is the new top tier: only super-admins
 * can create or promote admin accounts (enforced in admin.users.js), and
 * super-admin users receive every feature flag as `true` regardless of
 * their persisted feature_flags JSON (enforced in bot.auth.js).
 *
 * MySQL doesn't support altering enum values in place, so we stage via
 * a temporary string column.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('role_tmp', 16).notNullable().defaultTo('user');
  });
  await knex('users').update({ role_tmp: knex.ref('role') });
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('role');
  });
  await knex.schema.alterTable('users', (t) => {
    t.enu('role', ['super_admin', 'admin', 'user']).notNullable().defaultTo('user');
  });
  await knex('users').update({ role: knex.ref('role_tmp') });
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('role_tmp');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Demote any super_admin to admin on rollback — lossy by design.
  await knex('users').where('role', 'super_admin').update({ role: 'admin' });

  await knex.schema.alterTable('users', (t) => {
    t.string('role_tmp', 16).notNullable().defaultTo('user');
  });
  await knex('users').update({ role_tmp: knex.ref('role') });
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('role');
  });
  await knex.schema.alterTable('users', (t) => {
    t.enu('role', ['admin', 'user']).notNullable().defaultTo('user');
  });
  await knex('users').update({ role: knex.ref('role_tmp') });
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('role_tmp');
  });
}
