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
  // Order matters: MySQL refuses to drop the legacy index while it's
  // the only one covering the user_id FK. Create the new composite
  // (which also has user_id as its leading column and therefore can
  // back the FK) FIRST, then drop the legacy.

  // Step 1: ensure the correct composite unique exists.
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

  // Step 2: drop the legacy index. If MySQL still complains about the FK
  // (shouldn't happen now that the composite is there), fall back to the
  // full rotate: drop FK → drop index → recreate FK.
  const [legacyRows] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'bot_configs'
        AND INDEX_NAME   = 'bot_configs_user_id_char_name_unique'`
  );
  if (Number(legacyRows?.[0]?.c ?? 0) > 0) {
    try {
      await knex.raw('ALTER TABLE `bot_configs` DROP INDEX `bot_configs_user_id_char_name_unique`');
    } catch (err) {
      if (err?.code !== 'ER_DROP_INDEX_FK') throw err;

      // Resolve the FK name dynamically (Knex default is
      // `bot_configs_user_id_foreign`, but older DBs may have a
      // generated name like `bot_configs_ibfk_1`).
      const [fkRows] = await knex.raw(
        `SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA      = DATABASE()
            AND TABLE_NAME        = 'bot_configs'
            AND COLUMN_NAME       = 'user_id'
            AND REFERENCED_TABLE_NAME = 'users'`
      );
      const fkName = fkRows?.[0]?.name;
      if (!fkName) throw err;

      await knex.raw(`ALTER TABLE \`bot_configs\` DROP FOREIGN KEY \`${fkName}\``);
      await knex.raw('ALTER TABLE `bot_configs` DROP INDEX `bot_configs_user_id_char_name_unique`');
      await knex.raw(
        `ALTER TABLE \`bot_configs\` ADD CONSTRAINT \`${fkName}\`
           FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE`
      );
    }
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Intentionally a no-op: re-adding the broken legacy index would
  // immediately reproduce the bug. The correct shape is the composite
  // unique from migration 013; nothing to undo here.
}
