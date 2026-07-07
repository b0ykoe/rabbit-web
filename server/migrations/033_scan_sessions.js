//
// 033_scan_sessions.js
//
// Backend-issued RECORDING SESSIONS. A scan session is a bot-initiated
// recording window: the bot POSTs /api/bot/world/session/start, the portal
// mints a crypto.randomUUID() session_id and rows it here as 'running', and
// every spawn delta uploaded during that window carries the session_id so the
// portal can attribute + interlock recordings. session_id rides ALONGSIDE
// run_id (run_id stays the version bucket [030]); this table is the session
// registry and spawn_version_meta gains a nullable session_id back-reference.
//
// STRICTLY ADDITIVE on top of 032: no existing table/column is altered.
//
//   scan_sessions          — one row per recording session.
//       session_id  VARCHAR(36) PK   crypto.randomUUID() (or 'local-<run>' — but
//                                     local ids never reach the backend; backend
//                                     rows are always real uuids).
//       user_id     INT UNSIGNED NULL RESOLVED ingest user (from the license,
//                                     NEVER a client body field). Mirrors
//                                     spawn_version_meta.user_id convention.
//       server_id   INT UNSIGNED NULL upserted game server, when the bot knew it.
//       ip          VARCHAR(45)  NULL game server ip snapshot at start.
//       variant     VARCHAR(32)  NULL game server variant snapshot at start.
//       run_id      BIGINT       NULL the version bucket this session opened.
//       zone_no     INT          NULL zone at session start (informational).
//       status      VARCHAR(16)  NOT NULL DEFAULT 'running'  running|stopped|expired.
//       started_sec BIGINT       NOT NULL  session open time (epoch sec).
//       ended_sec   BIGINT       NULL  set on stop/expiry.
//       updated_at  BIGINT       NOT NULL  last mutation time.
//
//   idx_scan_sessions_user   (user_id, started_sec) — "my recent sessions".
//   idx_scan_sessions_srv    (server_id, status)    — "running sessions on srv"
//                                                      (lazy-expiry sweep target).
//
//   spawn_version_meta.session_id  VARCHAR(36) NULL — back-reference stamped on
//       INSERT ONLY (first-writer-wins, exactly like user_id [032]); the ingest
//       .merge() deliberately omits it. NULL for versions recorded before this
//       migration or without a session.
//
// All creates/alters are hasTable/hasColumn-guarded so a re-run is a no-op;
// down() reverses both (drop the added column+index, then drop the table).
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // ── scan_sessions ────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('scan_sessions'))) {
    await knex.schema.createTable('scan_sessions', (t) => {
      t.string('session_id', 36).notNullable().primary();   // crypto.randomUUID()
      t.integer('user_id').unsigned().nullable();            // resolved ingest user
      t.integer('server_id').unsigned().nullable();          // upserted game server
      t.string('ip', 45).nullable();
      t.string('variant', 32).nullable();
      t.bigInteger('run_id').nullable();                     // version bucket [030]
      t.integer('zone_no').nullable();
      t.string('status', 16).notNullable().defaultTo('running'); // running|stopped|expired
      t.bigInteger('started_sec').notNullable();
      t.bigInteger('ended_sec').nullable();
      t.bigInteger('updated_at').notNullable();
      // "my recent sessions, newest first."
      t.index(['user_id', 'started_sec'], 'idx_scan_sessions_user');
      // "running sessions on a server" — the lazy-expiry sweep + interlock read.
      t.index(['server_id', 'status'], 'idx_scan_sessions_srv');
    });
  }

  // ── spawn_version_meta.session_id (guarded add) ──────────────────────────
  if (await knex.schema.hasTable('spawn_version_meta')) {
    if (!(await knex.schema.hasColumn('spawn_version_meta', 'session_id'))) {
      await knex.schema.alterTable('spawn_version_meta', (t) => {
        // Nullable session back-reference; first-writer-wins (INSERT only).
        t.string('session_id', 36).nullable();
        t.index(['session_id'], 'idx_spawn_ver_meta_session');
      });
    }
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Reverse: drop the added column+index first, then the new table.
  if (await knex.schema.hasTable('spawn_version_meta')) {
    if (await knex.schema.hasColumn('spawn_version_meta', 'session_id')) {
      await knex.schema.alterTable('spawn_version_meta', (t) => {
        t.dropIndex(['session_id'], 'idx_spawn_ver_meta_session');
        t.dropColumn('session_id');
      });
    }
  }
  if (await knex.schema.hasTable('scan_sessions')) {
    await knex.schema.dropTable('scan_sessions');
  }
}
