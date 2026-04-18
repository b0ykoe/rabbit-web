/**
 * Add ip_address + last_ip_address columns to bot_sessions.
 *
 * `ip_address` captures req.ip at /auth/start — the IP the session was
 * opened from. `last_ip_address` is refreshed every /heartbeat so we can
 * detect mid-session IP changes (VPN switch, network hand-off, spoof).
 *
 * Both columns are super-admin-only visible. Plain admins see sessions
 * without IP fields; plain users never see them.
 *
 * IPv6 addresses are up to 45 characters (full form with zone ID), so
 * 45 is the canonical safe width.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  const has = {
    ip_address:      await knex.schema.hasColumn('bot_sessions', 'ip_address'),
    last_ip_address: await knex.schema.hasColumn('bot_sessions', 'last_ip_address'),
  };
  if (has.ip_address && has.last_ip_address) return;

  await knex.schema.alterTable('bot_sessions', (t) => {
    if (!has.ip_address)      t.string('ip_address', 45).nullable();
    if (!has.last_ip_address) t.string('last_ip_address', 45).nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('bot_sessions', (t) => {
    t.dropColumn('ip_address');
    t.dropColumn('last_ip_address');
  });
}
