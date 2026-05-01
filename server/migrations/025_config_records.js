//
// 025_config_records.js
//
// New fact-based config schema. Replaces the per-(user,type,char) blob
// model in bot_configs with two normalized tables:
//
//   config_records — one row per (account, ident_type, ident_a, ident_b)
//                    where the triple uniquely identifies a config subject:
//                      character          → (charName, "")
//                      profile            → (kind,     name)        kind∈hwid|ip|general
//                      character-profile  → (charName, presetName)
//
//   config_actives — one row per (account, scope) recording which named
//                    profile is currently "active" for that scope. Scope
//                    string examples:
//                      profile:hwid | profile:ip | profile:general
//                      character-profile:Heinz
//
// The migration ports every existing row of bot_configs into the new tables
// in an idempotent way (PK collisions = skip). The legacy bot_configs table
// is left in place as a backup; the legacy /api/bot/config/* endpoints will
// be re-pointed at the new tables in a sibling commit.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const hasRecords = await knex.schema.hasTable('config_records');
  if (!hasRecords) {
    await knex.schema.createTable('config_records', (t) => {
      t.bigInteger('account_id').notNullable();
      t.string('ident_type', 24).notNullable();      // 'character'|'profile'|'character-profile'
      t.string('ident_a', 64).notNullable();         // charName | profile-kind | charName
      t.string('ident_b', 64).notNullable().defaultTo(''); // '' | profile-name | preset-name
      t.json('data').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['account_id', 'ident_type', 'ident_a', 'ident_b']);
      t.index(['account_id', 'ident_type'], 'idx_account_type');
    });
  }

  const hasActives = await knex.schema.hasTable('config_actives');
  if (!hasActives) {
    await knex.schema.createTable('config_actives', (t) => {
      t.bigInteger('account_id').notNullable();
      t.string('scope', 96).notNullable();
      t.string('active_name', 64).notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['account_id', 'scope']);
    });
  }

  // ── Port data ──────────────────────────────────────────────────────────
  // Skip if bot_configs doesn't exist (fresh install) or is empty.
  const hasLegacy = await knex.schema.hasTable('bot_configs');
  if (!hasLegacy) return;

  const now = Math.floor(Date.now() / 1000);
  const legacy = await knex('bot_configs').select(
    'user_id', 'config_type', 'char_name', 'config_json'
  );

  for (const row of legacy) {
    let blob;
    try {
      blob = JSON.parse(row.config_json || '{}');
    } catch {
      blob = {};
    }
    if (!blob || typeof blob !== 'object') blob = {};

    const accountId = row.user_id;
    const charName  = row.char_name || '';

    if (row.config_type === 'global') {
      // Wrap as profile:general "default"
      await upsertRecord(knex, accountId, 'profile', 'general', 'default', blob, now);
      await upsertActive(knex, accountId, 'profile:general', 'default', now);
    } else if (row.config_type === 'character') {
      if (!charName) continue;
      await upsertRecord(knex, accountId, 'character-profile', charName, 'default', blob, now);
      await upsertActive(knex, accountId, `character-profile:${charName}`, 'default', now);
    } else if (row.config_type === 'hwid') {
      // Legacy HWID blob is FLAT: profiles at root, hwid.* settings, optionally "active".
      const active = typeof blob.active === 'string' ? blob.active : '';
      const settings = {};
      const profiles = {};
      for (const [k, v] of Object.entries(blob)) {
        if (k === 'active') continue;
        if (k.startsWith('hwid.')) { settings[k] = v; continue; }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          profiles[k] = v;
        }
      }
      // Settings live with the active profile body (legacy didn't separate);
      // keep them attached to whichever profile is active, or under "default"
      // if no active. Settings override profile keys on collision (none expected).
      const settingsTarget = active || 'default';
      const settingsCarried = Object.keys(settings).length > 0 ? { ...settings } : null;

      for (const [name, body] of Object.entries(profiles)) {
        const data = (name === settingsTarget && settingsCarried)
          ? { ...body, ...settingsCarried }
          : body;
        await upsertRecord(knex, accountId, 'profile', 'hwid', name, data, now);
      }
      // If there were settings but no profiles, persist a "default" with just settings.
      if (Object.keys(profiles).length === 0 && settingsCarried) {
        await upsertRecord(knex, accountId, 'profile', 'hwid', 'default', settingsCarried, now);
      }
      if (active) {
        await upsertActive(knex, accountId, 'profile:hwid', active, now);
      }
    } else if (row.config_type === 'ip-profiles') {
      // IP shape: {active, killswitch, profiles: {name: {...}}}
      const active = typeof blob.active === 'string' ? blob.active : '';
      const killswitch = !!blob.killswitch;
      const profiles = (blob.profiles && typeof blob.profiles === 'object') ? blob.profiles : {};
      // Stash killswitch on the active profile body (or a synthetic "default")
      // so the round-trip preserves the legacy field. The shim re-extracts it.
      const ksTarget = active || 'default';
      for (const [name, body] of Object.entries(profiles)) {
        if (!body || typeof body !== 'object') continue;
        const data = (name === ksTarget) ? { ...body, _killswitch: killswitch } : body;
        await upsertRecord(knex, accountId, 'profile', 'ip', name, data, now);
      }
      if (Object.keys(profiles).length === 0 && killswitch) {
        await upsertRecord(knex, accountId, 'profile', 'ip', 'default', { _killswitch: true }, now);
      }
      if (active) {
        await upsertActive(knex, accountId, 'profile:ip', active, now);
      }
    }
    // Unknown config_type rows are skipped silently.
  }
}

async function upsertRecord(knex, accountId, type, a, b, data, now) {
  const existing = await knex('config_records')
    .where({ account_id: accountId, ident_type: type, ident_a: a, ident_b: b })
    .first();
  if (existing) return; // idempotent: skip if already ported
  await knex('config_records').insert({
    account_id: accountId,
    ident_type: type,
    ident_a:    a,
    ident_b:    b,
    data:       JSON.stringify(data || {}),
    updated_at: now,
  });
}

async function upsertActive(knex, accountId, scope, name, now) {
  const existing = await knex('config_actives')
    .where({ account_id: accountId, scope }).first();
  if (existing) return; // idempotent
  await knex('config_actives').insert({
    account_id:  accountId,
    scope,
    active_name: name,
    updated_at:  now,
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('config_actives');
  await knex.schema.dropTableIfExists('config_records');
}
