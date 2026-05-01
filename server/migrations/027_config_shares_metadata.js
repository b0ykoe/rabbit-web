//
// 027_config_shares_metadata.js
//
// Adds metadata columns to config_shares so the user can:
//   - assign a human-readable label at share-creation time (`share_name`)
//   - soft-deactivate a share without losing it (`active` flag)
//
// Soft deactivation: when the user clicks "Deactivate" in the bot's
// Export pane, we flip `active` to false so the public /share/:id URL
// returns 404 — but the snapshot stays in the DB and can be reactivated
// later via PUT /api/bot/config/share/:id/active.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const hasTable = await knex.schema.hasTable('config_shares');
  if (!hasTable) return;

  const hasName = await knex.schema.hasColumn('config_shares', 'share_name');
  if (!hasName) {
    await knex.schema.alterTable('config_shares', (t) => {
      t.string('share_name', 96).notNullable().defaultTo('');
    });
  }

  const hasActive = await knex.schema.hasColumn('config_shares', 'active');
  if (!hasActive) {
    await knex.schema.alterTable('config_shares', (t) => {
      t.boolean('active').notNullable().defaultTo(true);
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const hasTable = await knex.schema.hasTable('config_shares');
  if (!hasTable) return;

  const hasName = await knex.schema.hasColumn('config_shares', 'share_name');
  if (hasName) {
    await knex.schema.alterTable('config_shares', (t) => {
      t.dropColumn('share_name');
    });
  }
  const hasActive = await knex.schema.hasColumn('config_shares', 'active');
  if (hasActive) {
    await knex.schema.alterTable('config_shares', (t) => {
      t.dropColumn('active');
    });
  }
}
