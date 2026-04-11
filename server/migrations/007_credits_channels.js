/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // Add credits + allowed_channels to users
  const hasCredits = await knex.schema.hasColumn('users', 'credits');
  if (!hasCredits) {
    await knex.schema.alterTable('users', (t) => {
      t.integer('credits').unsigned().notNullable().defaultTo(0).after('force_password_change');
      t.json('allowed_channels').nullable().after('credits');
    });
  }

  // Add channel to releases
  const hasChannel = await knex.schema.hasColumn('releases', 'channel');
  if (!hasChannel) {
    await knex.schema.alterTable('releases', (t) => {
      t.enum('channel', ['release', 'beta', 'alpha']).notNullable().defaultTo('release').after('type');
    });

    // Drop old unique constraint (type, version) and add new (type, version, channel)
    // MySQL requires knowing the index name — Knex names it releases_type_version_unique
    try {
      await knex.schema.alterTable('releases', (t) => {
        t.dropUnique(['type', 'version']);
      });
    } catch {
      // Index might not exist or have a different name — ignore
    }

    await knex.schema.alterTable('releases', (t) => {
      t.unique(['type', 'version', 'channel']);
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('credits');
    t.dropColumn('allowed_channels');
  });

  try {
    await knex.schema.alterTable('releases', (t) => {
      t.dropUnique(['type', 'version', 'channel']);
    });
  } catch { /* ignore */ }

  await knex.schema.alterTable('releases', (t) => {
    t.dropColumn('channel');
  });

  try {
    await knex.schema.alterTable('releases', (t) => {
      t.unique(['type', 'version']);
    });
  } catch { /* ignore */ }
}
