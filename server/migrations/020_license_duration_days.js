/**
 * Delay license expiry until redeem. A purchased-but-unclaimed key
 * previously started its countdown the moment it was bought, which
 * ate into the user's entitlement before they ever used it. With
 * `duration_days` stored on the license, `expires_at` stays NULL
 * until the redeem handler computes `now + duration_days`.
 *
 * Admin-created keys with a hand-entered `expires_at` are unaffected
 * — they already represent a concrete date, no duration arithmetic
 * needed.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  const hasCol = await knex.schema.hasColumn('licenses', 'duration_days');
  if (!hasCol) {
    await knex.schema.alterTable('licenses', (t) => {
      t.integer('duration_days').unsigned().nullable();
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  if (await knex.schema.hasColumn('licenses', 'duration_days')) {
    await knex.schema.alterTable('licenses', (t) => t.dropColumn('duration_days'));
  }
}
