/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // Add config_type to bot_configs
  const hasConfigType = await knex.schema.hasColumn('bot_configs', 'config_type');
  if (!hasConfigType) {
    await knex.schema.alterTable('bot_configs', (t) => {
      t.string('config_type', 16).notNullable().defaultTo('character');
    });
    // Make char_name nullable (for global/hwid configs that have no character)
    await knex.raw('ALTER TABLE `bot_configs` MODIFY `char_name` VARCHAR(64) NULL');
    // Drop old unique + add new one with config_type
    await knex.raw('ALTER TABLE `bot_configs` DROP INDEX `bot_configs_user_id_char_name_unique`');
    await knex.raw('ALTER TABLE `bot_configs` ADD UNIQUE `bot_configs_user_config_unique` (`user_id`, `config_type`, `char_name`)');
  }

  // Feature flags per user
  const hasFlags = await knex.schema.hasColumn('users', 'feature_flags');
  if (!hasFlags) {
    await knex.schema.alterTable('users', (t) => {
      t.json('feature_flags').nullable();
    });

    const defaultFlags = JSON.stringify({
      training: true, skills: true, monsters: true, statistics: true,
      combo: true, options: true, hwid_spoof: true,
      dev: false, dev_movement: false, dev_entities: false, dev_drops: false,
      dev_skills: false, dev_advanced: false, dev_blacklist: false,
      dev_obstacles: false, dev_npc: false, dev_combo: false,
    });
    await knex('users').update({ feature_flags: defaultFlags });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('feature_flags');
  });
  await knex.raw('ALTER TABLE `bot_configs` DROP INDEX `bot_configs_user_config_unique`');
  await knex.schema.alterTable('bot_configs', (t) => {
    t.dropColumn('config_type');
    t.unique(['user_id', 'char_name']);
  });
}
