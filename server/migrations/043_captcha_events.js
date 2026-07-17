//
// 043_captcha_events.js
//
// CAPTCHA telemetry. The bot auto-solves in-game captchas and reports one row
// per captcha here so we can see how often they fire, when, and how they were
// answered. RESOLVED ingest user only (from the license/token — NEVER a client
// body field), mirroring scan_sessions.user_id [033].
//
// STRICTLY ADDITIVE: no existing table/column is touched.
//
//   captcha_events
//       id           BIGINT PK AUTOINC
//       user_id      INT UNSIGNED NULL  resolved ingest user (from the token)
//       server_id    INT UNSIGNED NULL  admin-named server, when known (context)
//       zone_no      INT          NULL  player zone at show time (informational)
//       shown_at_ms  BIGINT       NULL  client GetTickCount at show (NOT a wall clock)
//       solved_at_ms BIGINT       NULL  client tick at submit; NULL if unsolved
//       solve_ms     INT          NULL  solved_at - shown_at (answer latency), NULL if unsolved
//       correct_id   INT          NULL  target item id from the show packet
//       chosen_slot  INT          NULL  slot answered with; NULL/-1 if none
//       slot_ids     TEXT         NULL  JSON array of the 8 choice item ids
//       method       VARCHAR(16)  NULL  id | text | none
//       outcome      VARCHAR(16)  NOT NULL  solved | unsolved | closed | superseded
//       raw_hex      TEXT         NULL  hex of the raw captcha show packet
//       created_sec  BIGINT       NOT NULL  server receive time (epoch sec)
//
//   idx_captcha_events_user  (user_id, created_sec)  — "my recent captchas".
//   idx_captcha_events_srv   (server_id, created_sec) — per-server view.
//
// hasTable-guarded so a re-run is a no-op; down() drops the table.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (!(await knex.schema.hasTable('captcha_events'))) {
    await knex.schema.createTable('captcha_events', (t) => {
      t.bigIncrements('id').primary();
      t.integer('user_id').unsigned().nullable();     // resolved ingest user
      t.integer('server_id').unsigned().nullable();    // admin-named server (context)
      t.integer('zone_no').nullable();
      t.bigInteger('shown_at_ms').nullable();
      t.bigInteger('solved_at_ms').nullable();
      t.integer('solve_ms').nullable();
      t.integer('correct_id').nullable();
      t.integer('chosen_slot').nullable();
      t.text('slot_ids').nullable();                   // JSON array string
      t.string('method', 16).nullable();
      t.string('outcome', 16).notNullable().defaultTo('unsolved');
      t.text('raw_hex').nullable();
      t.bigInteger('created_sec').notNullable();
      t.index(['user_id', 'created_sec'], 'idx_captcha_events_user');
      t.index(['server_id', 'created_sec'], 'idx_captcha_events_srv');
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  if (await knex.schema.hasTable('captcha_events')) {
    await knex.schema.dropTable('captcha_events');
  }
}
