//
// 044_captcha_event_source.js
//
// Adds captcha_events.source — where the bot got the ids for this row:
//   "packet" = decoded straight from the captcha show packet (wire hook)
//   "ui"     = read back out of the captcha window's icons (hook-free poll)
//   "test"   = a bot dev "packet-test" / "id-test" upload (synthetic, ignore in stats)
//
// So the admin captcha view can tell a real packet-decoded row apart from a
// window-recovered one at a glance. STRICTLY ADDITIVE: nullable, no backfill —
// pre-044 rows keep source NULL and simply render as "—".
//
// hasColumn-guarded so a re-run is a no-op; down() drops the column.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (!(await knex.schema.hasTable('captcha_events'))) return;
  if (!(await knex.schema.hasColumn('captcha_events', 'source'))) {
    await knex.schema.alterTable('captcha_events', (t) => {
      t.string('source', 16).nullable();   // "packet" | "ui" | "test"
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  if (!(await knex.schema.hasTable('captcha_events'))) return;
  if (await knex.schema.hasColumn('captcha_events', 'source')) {
    await knex.schema.alterTable('captcha_events', (t) => {
      t.dropColumn('source');
    });
  }
}
