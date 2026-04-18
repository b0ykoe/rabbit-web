/**
 * Make audit_logs.user_id nullable + drop the CASCADE FK that relied on
 * it. Bot-side audit events (failed_login, invalid_key, hwid_mismatch)
 * happen before any user is identified — the original NOT NULL schema
 * assumed only web-portal actions are audited, which is no longer true.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  // Drop the FK before altering the column (MySQL requirement).
  // The FK name follows knex convention `audit_logs_user_id_foreign`.
  try {
    await knex.schema.alterTable('audit_logs', (t) => {
      t.dropForeign(['user_id']);
    });
  } catch (_) {
    // If the FK was already gone (fresh DBs may differ), ignore.
  }

  await knex.schema.alterTable('audit_logs', (t) => {
    t.integer('user_id').unsigned().nullable().alter();
  });

  // Re-attach the FK, but SET NULL on delete so deleting a user doesn't
  // wipe their audit trail — opposite of the old CASCADE behaviour, which
  // was counter-productive for forensic purposes.
  await knex.schema.alterTable('audit_logs', (t) => {
    t.foreign('user_id').references('id').inTable('users').onDelete('SET NULL');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Rollback: purge rows with null user_id (can't be coerced to NOT NULL)
  // then restore the original constraint.
  await knex('audit_logs').whereNull('user_id').del();

  try {
    await knex.schema.alterTable('audit_logs', (t) => {
      t.dropForeign(['user_id']);
    });
  } catch (_) {}

  await knex.schema.alterTable('audit_logs', (t) => {
    t.integer('user_id').unsigned().notNullable().alter();
  });
  await knex.schema.alterTable('audit_logs', (t) => {
    t.foreign('user_id').references('id').inTable('users').onDelete('CASCADE');
  });
}
