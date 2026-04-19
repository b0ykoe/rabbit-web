/**
 * Repair migration: drop the legacy unique index `bot_configs_user_id_char_name_unique`
 * on bot_configs(user_id, char_name) if it still exists.
 *
 * Migration 013 was supposed to drop it and replace it with
 * `bot_configs_user_config_unique` on (user_id, config_type, char_name).
 * On at least one production DB the drop was skipped — likely because the
 * `config_type` column already existed when 013 ran, so the `if (!hasConfigType)`
 * branch (which contained the DROP INDEX + new unique) was bypassed.
 *
 * Symptom: INSERTs for (user_id, 'hwid', '') collide with existing
 * (user_id, 'global', '') rows on the legacy (user_id, char_name) index
 * even though the new (user_id, config_type, char_name) constraint permits them.
 * User-visible: HWID and Character saves fail with ER_DUP_ENTRY, Global save
 * "works" because its row already exists (path is UPDATE, not INSERT).
 *
 * Idempotent: only drops when the legacy index is present, and ensures the
 * correct composite unique exists afterwards.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  // MySQL: check information_schema for the legacy index
  const [legacyRows] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'bot_configs'
        AND INDEX_NAME   = 'bot_configs_user_id_char_name_unique'`
  );
  const legacyCount = Number(legacyRows?.[0]?.c ?? 0);
  if (legacyCount > 0) {
    await knex.raw('ALTER TABLE `bot_configs` DROP INDEX `bot_configs_user_id_char_name_unique`');
  }

  // Make sure the correct composite unique is in place. On DBs where 013
  // fully ran this is a no-op; on the broken DB we add it now.
  const [newRows] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'bot_configs'
        AND INDEX_NAME   = 'bot_configs_user_config_unique'`
  );
  const newCount = Number(newRows?.[0]?.c ?? 0);
  if (newCount === 0) {
    await knex.raw(
      'ALTER TABLE `bot_configs` ADD UNIQUE `bot_configs_user_config_unique` (`user_id`, `config_type`, `char_name`)'
    );
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Intentionally a no-op: re-adding the broken legacy index would
  // immediately reproduce the bug. The correct shape is the composite
  // unique from migration 013; nothing to undo here.
}
