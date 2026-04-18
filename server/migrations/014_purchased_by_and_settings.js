/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // Add purchased_by column to licenses
  const hasPurchasedBy = await knex.schema.hasColumn('licenses', 'purchased_by');
  if (!hasPurchasedBy) {
    await knex.schema.alterTable('licenses', (t) => {
      t.integer('purchased_by').unsigned().nullable()
        .references('id').inTable('users').onDelete('SET NULL');
    });
  }

  // Create settings table
  const hasSettings = await knex.schema.hasTable('settings');
  if (!hasSettings) {
    await knex.schema.createTable('settings', (t) => {
      t.string('key', 100).primary();
      t.text('value').notNullable();
      t.timestamps(true, true);
    });

    // Seed default settings
    await knex('settings').insert({ key: 'shop_enabled', value: 'true' });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('settings');
  const hasPurchasedBy = await knex.schema.hasColumn('licenses', 'purchased_by');
  if (hasPurchasedBy) {
    await knex.schema.alterTable('licenses', (t) => {
      t.dropForeign('purchased_by');
      t.dropColumn('purchased_by');
    });
  }
}
