/**
 * Token security hardening (W-1 + W-2):
 *
 * 1. token_version columns on users + licenses. Every signed token carries
 *    the owner's current token_version; verification rejects tokens whose
 *    version is older than the DB value. Bumping the column (on password
 *    reset, HWID reset, license revoke, or admin "kick user") invalidates
 *    all outstanding tokens for that principal instantly.
 *
 * 2. token_blocklist table. A short-lived revocation list keyed by the
 *    token's jti (random 16-byte UUID). Auth middleware rejects any
 *    token whose jti appears in this table. We only keep entries until
 *    their `expires_at` (matches the original token's exp), so the table
 *    stays small.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  // Token-version columns. Default 1 — all existing outstanding tokens
  // won't have this claim yet, but any refresh after the migration will
  // pick it up, and the verify-side check is lenient for missing claim
  // (treats as version 1) so no flash-revoke.
  const hasUserVer = await knex.schema.hasColumn('users', 'token_version');
  if (!hasUserVer) {
    await knex.schema.alterTable('users', (t) => {
      t.integer('token_version').unsigned().notNullable().defaultTo(1);
    });
  }
  const hasLicVer = await knex.schema.hasColumn('licenses', 'token_version');
  if (!hasLicVer) {
    await knex.schema.alterTable('licenses', (t) => {
      t.integer('token_version').unsigned().notNullable().defaultTo(1);
    });
  }

  // Blocklist table. A tiny table indexed by jti; we GC rows older than
  // their expiry in the same cleanup job that kills stale sessions.
  if (!(await knex.schema.hasTable('token_blocklist'))) {
    await knex.schema.createTable('token_blocklist', (t) => {
      t.string('jti', 32).primary();
      t.integer('expires_at').unsigned().notNullable(); // unix timestamp
      t.string('reason', 32).nullable();
      t.timestamps(true, true);
      t.index('expires_at'); // cleanup query
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  if (await knex.schema.hasTable('token_blocklist')) {
    await knex.schema.dropTable('token_blocklist');
  }
  if (await knex.schema.hasColumn('licenses', 'token_version')) {
    await knex.schema.alterTable('licenses', (t) => t.dropColumn('token_version'));
  }
  if (await knex.schema.hasColumn('users', 'token_version')) {
    await knex.schema.alterTable('users', (t) => t.dropColumn('token_version'));
  }
}
