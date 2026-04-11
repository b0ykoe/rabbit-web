/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // Add HWID to bot sessions
  const hasHwid = await knex.schema.hasColumn('bot_sessions', 'hwid');
  if (!hasHwid) {
    await knex.schema.alterTable('bot_sessions', (t) => {
      t.string('hwid', 128).nullable().after('license_key');
    });
  }

  // Add expires_at to licenses
  const hasExpiry = await knex.schema.hasColumn('licenses', 'expires_at');
  if (!hasExpiry) {
    await knex.schema.alterTable('licenses', (t) => {
      t.datetime('expires_at').nullable().after('note');
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('bot_sessions', (t) => { t.dropColumn('hwid'); });
  await knex.schema.alterTable('licenses', (t) => { t.dropColumn('expires_at'); });
}
