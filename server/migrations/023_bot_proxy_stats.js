/**
 * Per-SOCKS5-proxy traffic stats reported by the bot on each heartbeat.
 *
 * Client (inject.dll) sends a `proxy_stats[]` array keyed by profile name
 * under POST /api/bot/auth/heartbeat. Each row is cumulative since bot
 * start (= session start); the server upserts the latest values per
 * (session_id, profile) so an admin sees current totals without
 * doubly counting repeated heartbeats.
 *
 * Credentials are never transmitted — only `host`, `port`, and counters.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  if (await knex.schema.hasTable('bot_proxy_stats')) return;
  await knex.schema.createTable('bot_proxy_stats', (t) => {
    t.increments('id').primary();
    t.string('session_id', 64).notNullable().index();
    t.string('license_key', 32).notNullable().index();
    t.string('profile_name', 64).notNullable();
    t.string('host', 253).nullable();
    t.integer('port').unsigned().nullable();
    t.bigInteger('bytes_sent').unsigned().notNullable().defaultTo(0);
    t.bigInteger('bytes_recv').unsigned().notNullable().defaultTo(0);
    t.integer('sockets_active').unsigned().notNullable().defaultTo(0);
    t.integer('sockets_total').unsigned().notNullable().defaultTo(0);
    t.integer('recorded_at').unsigned().notNullable();

    // One row per (session_id, profile_name) — latest-wins semantics.
    t.unique(['session_id', 'profile_name']);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('bot_proxy_stats');
}
