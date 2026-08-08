//
// 045_captcha_event_ui_slot_ids.js
//
// Adds captcha_events.ui_slot_ids — the choice item ids the bot read back OUT OF
// the captcha window's icons (the hook-free "ui" fallback), stored alongside the
// packet-decoded slot_ids. Populated today by the bot's "Send a REAL test to
// backend (packet + window)" self-test, which reads the ids TWICE — from the
// packet (→ slot_ids, primary) and from the window (→ ui_slot_ids, fallback) —
// so the admin captcha view can show both and tell a packet decode apart from a
// window recovery.
//
// STRICTLY ADDITIVE: nullable TEXT (JSON array string), no backfill. Rows without
// a window read (every pre-045 row, and ordinary packet/poll events) keep it NULL
// and simply render as "—".
//
// hasColumn-guarded so a re-run is a no-op; down() drops the column.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (!(await knex.schema.hasTable('captcha_events'))) return;
  if (!(await knex.schema.hasColumn('captcha_events', 'ui_slot_ids'))) {
    await knex.schema.alterTable('captcha_events', (t) => {
      t.text('ui_slot_ids').nullable();   // JSON array of the 8 window-read item ids
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  if (!(await knex.schema.hasTable('captcha_events'))) return;
  if (await knex.schema.hasColumn('captcha_events', 'ui_slot_ids')) {
    await knex.schema.alterTable('captcha_events', (t) => {
      t.dropColumn('ui_slot_ids');
    });
  }
}
