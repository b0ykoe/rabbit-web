//
// 047_release_arch.js
//
// Add a nullable `arch` column to `releases` so a DLL release can be
// uploaded per architecture (x86 vs x64) and the loader picks the file
// matching the target process.
//
// Model (backward-compatible):
//   arch = NULL           → "arch-agnostic" — the single file uploaded for a
//                            version (all pre-047 rows; a plain single upload
//                            after 047 that leaves arch empty).
//   arch = 'x86'          → 32-bit inject.dll (game client is x86 / running
//                            under WoW64 on x64 Windows).
//   arch = 'x64'          → 64-bit inject_x64.dll (native x64 game client).
//
// The unique constraint moves from (type, channel, version) → (type, channel,
// version, arch) so BOTH an x86 and an x64 row can share a version for the same
// channel. MySQL treats NULLs as distinct under a UNIQUE index, so a legacy
// NULL row and its arch-specific successors can also coexist.
//
// The bot download endpoint (bot.download.js) applies this fallback chain:
//   1. arch given         → exact-arch row; else fall back to arch=NULL row.
//   2. arch not given     → arch=NULL row; else 'x86' (legacy client default).
//   3. still no match     → 503 (never serve a wrong-arch DLL).
//
// The activate/deactivate + duplicate-upload scope in admin.releases.js now
// also keys on arch so activating the x86 build does NOT deactivate the x64
// build (each arch has its own active row within a channel).
//
// DDL only — `transaction: false` (mixing DDL with a transaction trips MySQL
// implicit-commit; mirrors migrations 038–041 + 046).
//

export const config = { transaction: false };

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  if (!(await knex.schema.hasTable('releases'))) return;

  // Add the nullable arch column, guarded so a re-run is a no-op.
  if (!(await knex.schema.hasColumn('releases', 'arch'))) {
    await knex.schema.alterTable('releases', (t) => {
      // Small enum for tight indexing; NULL is the arch-agnostic sentinel.
      t.enum('arch', ['x86', 'x64']).nullable();
    });
  }

  // Move the uniqueness from (type, channel, version) → (type, channel,
  // version, arch). knex's dropUnique + unique both accept a stable index
  // name so we can idempotently swap even when the auto-generated name
  // differs (best-effort dropUnique + a new named unique with hasUnique
  // guard would be nicer, but knex has no hasUnique — so we swallow the
  // drop error to keep the migration re-runnable).
  try {
    await knex.schema.alterTable('releases', (t) => {
      t.dropUnique(['type', 'channel', 'version'], 'releases_type_channel_version_unique');
    });
  } catch (_) {
    // Old install may name the constraint differently (created by migration
    // 004 originally as (type,version), later re-formed to include channel);
    // try the (type, version) shape too. Swallow if neither exists — the new
    // add below will still succeed.
    try {
      await knex.schema.alterTable('releases', (t) => {
        t.dropUnique(['type', 'version']);
      });
    } catch (__) { /* nothing to drop */ }
  }

  // Add the new composite unique. Guard against re-run by catching the
  // "duplicate key name" error MySQL raises when it already exists.
  try {
    await knex.schema.alterTable('releases', (t) => {
      t.unique(['type', 'channel', 'version', 'arch'], {
        indexName: 'releases_type_channel_version_arch_unique',
      });
    });
  } catch (e) {
    // If knex versions differ on the options-object signature, or the index
    // already exists from a partial prior run, ignore and continue — the
    // schema is idempotent from the app's perspective.
    if (e && /Duplicate key name|already exists/i.test(String(e.message || ''))) {
      // idempotent no-op
    } else {
      throw e;
    }
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  if (!(await knex.schema.hasTable('releases'))) return;

  // Reverse the unique swap. Same best-effort guards — the goal is a clean
  // rollback, not a hard failure if the constraint name drifted.
  try {
    await knex.schema.alterTable('releases', (t) => {
      t.dropUnique(
        ['type', 'channel', 'version', 'arch'],
        'releases_type_channel_version_arch_unique',
      );
    });
  } catch (_) { /* not present — nothing to drop */ }

  try {
    await knex.schema.alterTable('releases', (t) => {
      t.unique(['type', 'channel', 'version'], {
        indexName: 'releases_type_channel_version_unique',
      });
    });
  } catch (e) {
    if (e && /Duplicate key name|already exists/i.test(String(e.message || ''))) {
      // idempotent
    } else {
      throw e;
    }
  }

  if (await knex.schema.hasColumn('releases', 'arch')) {
    await knex.schema.alterTable('releases', (t) => {
      t.dropColumn('arch');
    });
  }
}
