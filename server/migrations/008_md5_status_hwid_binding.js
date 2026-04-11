/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // MD5 hash on releases
  if (!(await knex.schema.hasColumn('releases', 'md5'))) {
    await knex.schema.alterTable('releases', (t) => {
      t.string('md5', 32).nullable().after('sha256');
    });
  }

  // User status (custom text set by admin, shown everywhere)
  if (!(await knex.schema.hasColumn('users', 'status'))) {
    await knex.schema.alterTable('users', (t) => {
      t.string('status', 255).nullable().after('allowed_channels');
    });
  }

  // Per-user HWID reset toggle (default: enabled)
  if (!(await knex.schema.hasColumn('users', 'hwid_reset_enabled'))) {
    await knex.schema.alterTable('users', (t) => {
      t.boolean('hwid_reset_enabled').notNullable().defaultTo(true).after('status');
    });
  }

  // Bound HWID per license key (once used, key is locked to this HWID until reset)
  if (!(await knex.schema.hasColumn('licenses', 'bound_hwid'))) {
    await knex.schema.alterTable('licenses', (t) => {
      t.string('bound_hwid', 128).nullable().after('expires_at');
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('releases', (t) => { t.dropColumn('md5'); });
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('status');
    t.dropColumn('hwid_reset_enabled');
  });
  await knex.schema.alterTable('licenses', (t) => { t.dropColumn('bound_hwid'); });
}
