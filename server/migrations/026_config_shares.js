//
// 026_config_shares.js
//
// Server-side persistent config snapshots for share-by-URL.
//
// When a user clicks "Create share URL" in the bot's Import/Export pane,
// the inject DLL POSTs the full PortableExport JSON here and gets back a
// short share_id. The snapshot is stored verbatim — later edits to the
// user's profiles do NOT modify it, so the URL keeps pointing at the
// original config the user shared.
//
// share_id is opaque random hex (16 chars = 64 bits entropy). URLs look
// like https://rabbitlc.xyz/share/<share_id>. The inject's Import pane
// accepts either the full URL or just the id.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const has = await knex.schema.hasTable('config_shares');
  if (has) return;
  await knex.schema.createTable('config_shares', (t) => {
    t.string('share_id', 32).notNullable().primary();
    t.bigInteger('account_id').notNullable();        // creator
    t.json('data').notNullable();                    // PortableExport JSON
    t.bigInteger('created_at').notNullable();
    t.index(['account_id', 'created_at'], 'idx_account_created');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('config_shares');
}
