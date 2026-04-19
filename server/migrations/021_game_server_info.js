/**
 * Add game-server columns to bot_sessions.
 *
 * These capture which LastChaos server the bot client is connected to,
 * reported by the bot on each heartbeat:
 *   - game_server_ip      : remote IP of the established TCP socket
 *                           (IPv4 today; 45 chars to leave room for IPv6)
 *   - game_server_port    : remote port (string, so "5555" formatting)
 *   - game_server_variant : bot's detected variant ("Nemesis" / "EP4 Stock" /
 *                           "Unknown"), resolved from Engine.dll fingerprint
 *                           + user override in Options
 *
 * Unlike ip_address/last_ip_address (the admin-client IP, super-admin-only),
 * these fields are visible to every admin — a game-server endpoint is a
 * public address and not personally identifying.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  const has = {
    game_server_ip:      await knex.schema.hasColumn('bot_sessions', 'game_server_ip'),
    game_server_port:    await knex.schema.hasColumn('bot_sessions', 'game_server_port'),
    game_server_variant: await knex.schema.hasColumn('bot_sessions', 'game_server_variant'),
  };
  if (has.game_server_ip && has.game_server_port && has.game_server_variant) return;

  await knex.schema.alterTable('bot_sessions', (t) => {
    if (!has.game_server_ip)      t.string('game_server_ip', 45).nullable();
    if (!has.game_server_port)    t.string('game_server_port', 8).nullable();
    if (!has.game_server_variant) t.string('game_server_variant', 32).nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('bot_sessions', (t) => {
    t.dropColumn('game_server_ip');
    t.dropColumn('game_server_port');
    t.dropColumn('game_server_variant');
  });
}
