//
// 028_flatten_character_profiles.js
//
// Drops the per-character preset model and ports every legacy
// `character-profile:<charName>:<presetName>` record into the flat
// `profile:character:<presetName>` pool — so Character profiles work
// like HWID/IP/Options profiles (account-wide list, one active pointer).
//
// Conflict rule: when multiple charNames had the same preset name (e.g.
// "Heinz" + "Lara" both have a "farming" preset), the most-recently-edited
// one wins the unprefixed slot. Older duplicates land at "<presetName>
// (<charName>)" so the user keeps everything but knows what came from
// where. Idempotent — re-running is a no-op once the legacy rows are gone.
//
// Active pointer: the per-char `character-profile:<charName>` actives are
// collapsed to a single `profile:character` active. We pick the most-
// recently-updated active across all chars; if the picked name was renamed
// during conflict-handling above, the suffixed name is used.
//

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const hasRecords = await knex.schema.hasTable('config_records');
  const hasActives = await knex.schema.hasTable('config_actives');
  if (!hasRecords || !hasActives) return;

  const legacyRecords = await knex('config_records')
    .where({ ident_type: 'character-profile' })
    .select('account_id', 'ident_a', 'ident_b', 'data', 'updated_at')
    .orderBy('updated_at', 'desc');

  // Group by (accountId, presetName) so we can resolve name collisions
  // in-bulk per account.
  const byAccount = new Map();   // accountId -> Map<presetName, [{charName, data, updated_at}, ...]>
  for (const r of legacyRecords) {
    if (!r.ident_b) continue;
    const acc = String(r.account_id);
    const presetName = String(r.ident_b);
    let group = byAccount.get(acc);
    if (!group) { group = new Map(); byAccount.set(acc, group); }
    let bucket = group.get(presetName);
    if (!bucket) { bucket = []; group.set(presetName, bucket); }
    bucket.push({
      charName:   String(r.ident_a),
      data:       parseJson(r.data),
      updated_at: Number(r.updated_at) || 0,
    });
  }

  // Map<accountId, Map<oldKey ("<charName>:<presetName>") -> newName>> — used
  // when porting active pointers below.
  const renameByAccount = new Map();

  for (const [acc, group] of byAccount.entries()) {
    const accountId = Number(acc);
    const renameForThisAcc = new Map();
    for (const [presetName, bucket] of group.entries()) {
      // bucket is already updated_at DESC. The first entry keeps the clean
      // name; subsequent duplicates get a "<presetName> (<charName>)" suffix.
      // If the suffixed name itself collides, append a numeric tiebreaker.
      const claimedNames = new Set();
      // Make sure we don't collide with an existing flat profile of the
      // same name (HWID/IP unaffected; same kind only).
      const existing = await knex('config_records')
        .where({ account_id: accountId, ident_type: 'profile', ident_a: 'character' })
        .select('ident_b');
      for (const e of existing) claimedNames.add(String(e.ident_b));

      for (let i = 0; i < bucket.length; ++i) {
        const entry = bucket[i];
        let target = (i === 0 && !claimedNames.has(presetName))
          ? presetName
          : `${presetName} (${entry.charName})`;
        if (claimedNames.has(target)) {
          // Numeric tiebreaker for the rare double-collision.
          for (let n = 2; n < 100; ++n) {
            const cand = `${presetName} (${entry.charName} ${n})`;
            if (!claimedNames.has(cand)) { target = cand; break; }
          }
        }
        claimedNames.add(target);
        renameForThisAcc.set(`${entry.charName}:${presetName}`, target);

        // Insert the flat profile row (skip if a no-op re-run already wrote it).
        const dupCheck = await knex('config_records')
          .where({
            account_id: accountId,
            ident_type: 'profile',
            ident_a:    'character',
            ident_b:    target,
          })
          .first();
        if (!dupCheck) {
          await knex('config_records').insert({
            account_id: accountId,
            ident_type: 'profile',
            ident_a:    'character',
            ident_b:    target,
            data:       JSON.stringify(entry.data || {}),
            updated_at: entry.updated_at,
          });
        }
      }
    }
    renameByAccount.set(accountId, renameForThisAcc);
  }

  // ── Port the per-char active pointers into a single flat one ──────────
  const legacyActives = await knex('config_actives')
    .where('scope', 'like', 'character-profile:%')
    .select('account_id', 'scope', 'active_name', 'updated_at')
    .orderBy('updated_at', 'desc');

  const activeByAccount = new Map();   // accountId -> { name, updated_at }
  for (const a of legacyActives) {
    const accountId = Number(a.account_id);
    if (activeByAccount.has(accountId)) continue; // we keep the newest only
    if (!a.active_name) continue;
    const charName = String(a.scope).slice('character-profile:'.length);
    const renames  = renameByAccount.get(accountId);
    const newName  = (renames && renames.get(`${charName}:${a.active_name}`))
      || a.active_name;
    activeByAccount.set(accountId, { name: newName, updated_at: a.updated_at });
  }

  for (const [accountId, info] of activeByAccount.entries()) {
    const exists = await knex('config_actives')
      .where({ account_id: accountId, scope: 'profile:character' })
      .first();
    if (exists) continue;
    await knex('config_actives').insert({
      account_id:  accountId,
      scope:       'profile:character',
      active_name: info.name,
      updated_at:  info.updated_at || Math.floor(Date.now() / 1000),
    });
  }

  // ── Drop the legacy rows now that they've been ported ─────────────────
  // We delete instead of leaving them around because the new client never
  // reads them, and stale shadows would just confuse server-side debugging.
  await knex('config_records').where({ ident_type: 'character-profile' }).delete();
  await knex('config_actives').where('scope', 'like', 'character-profile:%').delete();
}

function parseJson(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

/** @param {import('knex').Knex} knex */
export async function down(_knex) {
  // No-op: the flatten loses per-char attribution by design (collisions
  // were rewritten or merged). Going back would need an external backup.
}
