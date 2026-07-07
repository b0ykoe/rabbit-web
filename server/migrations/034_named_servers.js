//
// 034_named_servers.js
//
// SERVER-IDENTITY REDESIGN. Spawn data becomes keyed by an ADMIN-DEFINED
// NAMED server (the existing INT game_servers.id), never by ip/port/channel.
// The channel dimension is COLLAPSED to 0 everywhere (columns kept for schema
// stability, always written 0, never filtered). Existing rows are FOLDED
// ONE-NAMED-SERVER-PER-VARIANT: for each variant the MIN(id) row survives and
// every other same-variant server's child rows are re-pointed onto it with an
// ADDITIVE collision merge (channel -> 0 in the same pass).
//
// Schema deltas (mirrors the 029/033 house style — hasTable/hasColumn guards,
// ESM up/down, one knex.transaction wrapping the fold):
//
//   game_servers.name  VARCHAR(128) NULL — the admin-facing server name. Seeded
//                       from COALESCE(display_name, variant). ip/variant/port
//                       columns are KEPT (vestigial: legacy resolve + the
//                       scan_sessions ip/variant snapshot). The UNIQUE(ip,variant)
//                       constraint is DROPPED (many hosts may share a variant now).
//
//   game_server_hosts  NEW — the set of known IPs per server, for bot
//                       preselection. UNIQUE(ip) so an ip resolves to exactly
//                       one server; INDEX(server_id) for the fan-out read.
//
// The FOLD merge is done with raw mysql2 INSERT..SELECT..GROUP BY (WITHOUT
// channel) .. ON DUPLICATE KEY UPDATE col = col + VALUES(col) so re-pointed +
// channel-collapsed rows accumulate exactly (never a bare survivor overwrite).
// Every guard/probe makes a re-run a no-op.
//
// down() restores SCHEMA ONLY. The row fold is NOT reversible — once two
// servers' heat is summed into one, the constituent servers cannot be split
// back. down() drops game_server_hosts, drops game_servers.name, and re-adds
// the UNIQUE(ip,variant) constraint; it does not (and cannot) un-merge rows.
//

// ── helpers ────────────────────────────────────────────────────────────────

/** True iff a named index exists on a table in the current schema. */
async function indexExists(knex, table, indexName) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = ?
        AND INDEX_NAME   = ?`,
    [table, indexName]
  );
  return Number(rows?.[0]?.c ?? 0) > 0;
}

/**
 * Re-point + channel-collapse one child table from `srcId` (or, when srcId is
 * null, the survivor's own channel<>0 rows) into `survivorId` with an ADDITIVE
 * collision merge, then delete the drained source rows.
 *
 * `keyCols` are the surviving-PK columns AFTER server_id/channel are pinned
 * (i.e. everything the GROUP BY must retain, e.g. zone_no,mob_id,cell_x,cell_z
 * [,version_id]). `aggSelect` is the SELECT list for the value columns (with
 * the aggregation applied, e.g. SUM(hits)), and `onDup` is the ON DUPLICATE KEY
 * UPDATE assignment list.
 *
 * When srcId === null we collapse the survivor's OWN channel<>0 rows: source =
 * survivor rows with channel<>0, and we exclude the channel=0 rows so the
 * GROUP BY folds the non-zero channels together before merging into channel 0.
 */
async function foldChild(trx, table, survivorId, srcId, keyCols, aggSelect, onDup) {
  const keyList = keyCols.join(', ');
  const groupBy = keyCols.join(', ');
  const where =
    srcId === null
      ? `WHERE server_id = ? AND channel <> 0`
      : `WHERE server_id = ?`;
  const whereParam = srcId === null ? survivorId : srcId;

  // INSERT..SELECT the re-pointed rows onto the survivor at channel 0. The
  // SELECT is wrapped in a derived table so MySQL fully materializes the
  // aggregate BEFORE writing back into the SAME table — this makes the
  // read-then-write explicit and avoids the replication-unsafe classification
  // of a bare INSERT..SELECT..ON DUPLICATE KEY over its own table.
  await trx.raw(
    `INSERT INTO \`${table}\` (server_id, ${keyList}, channel, ${aggSelect.cols})
       SELECT * FROM (
         SELECT ?, ${keyList}, 0 AS channel, ${aggSelect.exprs}
           FROM \`${table}\`
          ${where}
          GROUP BY ${groupBy}
       ) AS dt
     ON DUPLICATE KEY UPDATE ${onDup}`,
    [survivorId, whereParam]
  );

  // Delete the drained source rows.
  if (srcId === null) {
    await trx.raw(
      `DELETE FROM \`${table}\` WHERE server_id = ? AND channel <> 0`,
      [survivorId]
    );
  } else {
    await trx.raw(`DELETE FROM \`${table}\` WHERE server_id = ?`, [srcId]);
  }
}

// The child-table merge descriptors. Each fold, whether cross-server (srcId set)
// or self-collapse (srcId null), uses the same additive semantics.

// mob_spawn_cells — the all-time heat.
const CELLS = {
  cols: 'y_avg, hits, passes, instance_sum, last_hit_run_id, last_pass_run_id, first_seen_sec, last_seen_sec',
  exprs:
    'MAX(y_avg), SUM(hits), SUM(passes), SUM(instance_sum), ' +
    'MAX(last_hit_run_id), MAX(last_pass_run_id), MIN(first_seen_sec), MAX(last_seen_sec)',
  onDup:
    'hits = hits + VALUES(hits), passes = passes + VALUES(passes), ' +
    'instance_sum = instance_sum + VALUES(instance_sum), ' +
    'last_hit_run_id = GREATEST(last_hit_run_id, VALUES(last_hit_run_id)), ' +
    'last_pass_run_id = GREATEST(last_pass_run_id, VALUES(last_pass_run_id)), ' +
    'first_seen_sec = LEAST(first_seen_sec, VALUES(first_seen_sec)), ' +
    'last_seen_sec = GREATEST(last_seen_sec, VALUES(last_seen_sec)), ' +
    'y_avg = COALESCE(VALUES(y_avg), y_avg)',
  keyCols: ['zone_no', 'mob_id', 'cell_x', 'cell_z'],
};

// mob_spawn_cell_versions — the versioned heat. version_id is kept in the key
// (NOT collapsed) — only channel folds.
const CELL_VERSIONS = {
  // version_id is a KEY column (see keyCols) so foldChild already emits it in the
  // key list, SELECT, and GROUP BY. It must NOT be repeated in cols/exprs or the
  // generated INSERT column list carries a DUPLICATE `version_id`.
  cols: 'hits, passes, instance_sum, last_hit_run_id, last_pass_run_id, y_avg, first_seen_sec, last_seen_sec',
  exprs:
    'SUM(hits), SUM(passes), SUM(instance_sum), ' +
    'MAX(last_hit_run_id), MAX(last_pass_run_id), MAX(y_avg), ' +
    'MIN(first_seen_sec), MAX(last_seen_sec)',
  onDup:
    'hits = hits + VALUES(hits), passes = passes + VALUES(passes), ' +
    'instance_sum = instance_sum + VALUES(instance_sum), ' +
    'last_hit_run_id = GREATEST(last_hit_run_id, VALUES(last_hit_run_id)), ' +
    'last_pass_run_id = GREATEST(last_pass_run_id, VALUES(last_pass_run_id)), ' +
    'y_avg = COALESCE(VALUES(y_avg), y_avg), ' +
    'first_seen_sec = LEAST(first_seen_sec, VALUES(first_seen_sec)), ' +
    'last_seen_sec = GREATEST(last_seen_sec, VALUES(last_seen_sec))',
  keyCols: ['zone_no', 'mob_id', 'cell_x', 'cell_z', 'version_id'],
};

/**
 * mob_catalog / spawn_version_meta / zone_bounds / zone_maps have NO channel
 * column, so a cross-server fold is a straight re-point with a widening merge
 * (or survivor-wins). Implemented inline in foldFlatChild below.
 */
async function foldFlatChild(trx, table, survivorId, srcId, keyCols, cols, exprs, onDup) {
  const keyList = keyCols.join(', ');
  const groupBy = keyCols.join(', ');
  await trx.raw(
    `INSERT INTO \`${table}\` (server_id, ${keyList}, ${cols})
       SELECT * FROM (
         SELECT ?, ${keyList}, ${exprs}
           FROM \`${table}\`
          WHERE server_id = ?
          GROUP BY ${groupBy}
       ) AS dt
     ON DUPLICATE KEY UPDATE ${onDup}`,
    [survivorId, srcId]
  );
  await trx.raw(`DELETE FROM \`${table}\` WHERE server_id = ?`, [srcId]);
}

// This migration MIXES DDL (add column / create table / drop index) with a
// transactional data fold. In MySQL every DDL statement IMPLICITLY COMMITS the
// open transaction, which breaks knex's default per-migration transaction wrapper
// (error #805 "Transaction was implicitly committed, do not mix transactions and
// DDL"). So disable the wrapper: the DDL runs in autocommit, and the row fold
// runs inside its OWN explicit knex.transaction() below (the only part that needs
// atomicity). Every step is independently guarded, so a mid-way failure + re-run
// is a no-op.
export const config = { transaction: false };

// ── up ───────────────────────────────────────────────────────────────────────

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // 1. game_servers.name (nullable add) ─────────────────────────────────────
  if (await knex.schema.hasTable('game_servers')) {
    if (!(await knex.schema.hasColumn('game_servers', 'name'))) {
      await knex.schema.alterTable('game_servers', (t) => {
        t.string('name', 128).nullable(); // admin-facing server name
      });
    }
  }

  // 2. game_server_hosts (guarded create) ───────────────────────────────────
  if (!(await knex.schema.hasTable('game_server_hosts'))) {
    await knex.schema.createTable('game_server_hosts', (t) => {
      t.increments('id').primary();
      t.integer('server_id').unsigned().notNullable();
      t.string('ip', 45).nullable();
      t.string('hostname', 253).nullable();
      t.string('port', 8).nullable();
      t.unique(['ip']);              // an ip resolves to exactly one server
      t.index(['server_id'], 'idx_game_server_hosts_srv');
    });
  }

  // 3. Seed name = COALESCE(display_name, variant) where still NULL ──────────
  if (await knex.schema.hasColumn('game_servers', 'name')) {
    await knex.raw(
      `UPDATE game_servers
          SET name = COALESCE(display_name, variant)
        WHERE name IS NULL`
    );
  }

  // 4. Seed hosts from every game_servers row with a non-null ip, deduped on
  //    ip (skip an ip already present in game_server_hosts). ────────────────
  await knex.raw(
    `INSERT INTO game_server_hosts (server_id, ip, port)
       SELECT gs.id, gs.ip, gs.port
         FROM game_servers gs
        WHERE gs.ip IS NOT NULL
          AND gs.ip <> ''
          AND NOT EXISTS (
                SELECT 1 FROM game_server_hosts h WHERE h.ip = gs.ip
              )`
  );

  // 5. FOLD per variant inside ONE transaction ──────────────────────────────
  //    Survivor = MIN(id) per variant. Re-point every host row of the group to
  //    the survivor, additively merge+channel-collapse every child table, then
  //    delete the non-survivor game_servers rows and stamp survivor name/visible.
  await knex.transaction(async (trx) => {
    // Groups with >1 member need a cross-server fold; ALL survivors still get a
    // self channel-collapse (channel<>0 -> 0) below.
    const [groups] = await trx.raw(
      `SELECT variant,
              MIN(id) AS survivor_id
         FROM game_servers
        GROUP BY variant`
    );

    for (const g of groups ?? []) {
      const survivorId = Number(g.survivor_id);
      const variant = g.variant;

      // Capture the GROUP roll-ups NOW, BEFORE any non-survivor row is deleted
      // (they get deleted inside the srcId loop below, so the display_name /
      // visible values would be gone by the time we stamp the survivor):
      //  - name    = the first (lowest-id) non-null display_name in the group.
      //  - visible = OR of the group (MAX over the tinyint) so a merged server
      //              stays public if ANY constituent was visible.
      const [dnRows] = await trx.raw(
        `SELECT display_name FROM game_servers
          WHERE variant <=> ? AND display_name IS NOT NULL
          ORDER BY id LIMIT 1`,
        [variant]
      );
      const groupDisplayName = dnRows?.[0]?.display_name ?? null;
      const [visRows] = await trx.raw(
        `SELECT MAX(visible) AS v FROM game_servers WHERE variant <=> ?`,
        [variant]
      );
      const groupVisible = Number(visRows?.[0]?.v ?? 0) > 0 ? 1 : 0;

      // Non-survivor ids in this variant group.
      const [members] = await trx.raw(
        `SELECT id FROM game_servers WHERE variant <=> ? AND id <> ?`,
        [variant, survivorId]
      );
      const srcIds = (members ?? []).map((r) => Number(r.id));

      for (const srcId of srcIds) {
        // Re-point host rows onto the survivor (ip is UNIQUE across the whole
        // table, so a re-point can only collide with the survivor's own ip —
        // in that case the source host is redundant, drop it).
        await trx.raw(
          `UPDATE IGNORE game_server_hosts SET server_id = ? WHERE server_id = ?`,
          [survivorId, srcId]
        );
        await trx.raw(`DELETE FROM game_server_hosts WHERE server_id = ?`, [srcId]);

        // Additive collision-merge + channel-collapse of the channelled heat.
        await foldChild(trx, 'mob_spawn_cells', survivorId, srcId,
          CELLS.keyCols, CELLS, CELLS.onDup);
        await foldChild(trx, 'mob_spawn_cell_versions', survivorId, srcId,
          CELL_VERSIONS.keyCols, CELL_VERSIONS, CELL_VERSIONS.onDup);

        // Flat (channel-less) children — widening / additive merge.
        await foldFlatChild(trx, 'mob_catalog', survivorId, srcId,
          ['mob_id'],
          'name, level_min, level_max, maxhp_min, maxhp_max, sightings_total, last_seen',
          'MAX(name), MIN(level_min), MAX(level_max), MIN(maxhp_min), MAX(maxhp_max), ' +
            'SUM(sightings_total), MAX(last_seen)',
          'name = COALESCE(name, VALUES(name)), ' +
            'level_min = LEAST(COALESCE(level_min, VALUES(level_min)), COALESCE(VALUES(level_min), level_min)), ' +
            'level_max = GREATEST(COALESCE(level_max, VALUES(level_max)), COALESCE(VALUES(level_max), level_max)), ' +
            'maxhp_min = LEAST(COALESCE(maxhp_min, VALUES(maxhp_min)), COALESCE(VALUES(maxhp_min), maxhp_min)), ' +
            'maxhp_max = GREATEST(COALESCE(maxhp_max, VALUES(maxhp_max)), COALESCE(VALUES(maxhp_max), maxhp_max)), ' +
            'sightings_total = sightings_total + VALUES(sightings_total), ' +
            'last_seen = GREATEST(last_seen, VALUES(last_seen))');

        await foldFlatChild(trx, 'spawn_version_meta', survivorId, srcId,
          ['zone_no', 'version_id'],
          'ver_start_sec, ver_end_sec, run_count, updated_at, user_id, session_id',
          'MIN(ver_start_sec), MAX(ver_end_sec), SUM(run_count), MAX(updated_at), ' +
            'MIN(user_id), MIN(session_id)',
          'ver_start_sec = LEAST(ver_start_sec, VALUES(ver_start_sec)), ' +
            'ver_end_sec = GREATEST(ver_end_sec, VALUES(ver_end_sec)), ' +
            'run_count = run_count + VALUES(run_count), ' +
            'updated_at = GREATEST(updated_at, VALUES(updated_at)), ' +
            'user_id = COALESCE(user_id, VALUES(user_id)), ' +
            'session_id = COALESCE(session_id, VALUES(session_id))');

        // zone_bounds / zone_maps — survivor-wins per zone: INSERT..SELECT and
        // on a collision KEEP the survivor's existing row (no-op update).
        await trx.raw(
          `INSERT INTO zone_bounds
             (server_id, zone_no, origin_x, origin_z, world_min_x, world_min_z,
              world_max_x, world_max_z, size_px, meters_per_pixel, cell_size_m, updated_at)
             SELECT ?, zone_no, origin_x, origin_z, world_min_x, world_min_z,
                    world_max_x, world_max_z, size_px, meters_per_pixel, cell_size_m, updated_at
               FROM zone_bounds WHERE server_id = ?
           ON DUPLICATE KEY UPDATE zone_no = zone_bounds.zone_no`,
          [survivorId, srcId]
        );
        await trx.raw(`DELETE FROM zone_bounds WHERE server_id = ?`, [srcId]);

        await trx.raw(
          `INSERT INTO zone_maps
             (server_id, zone_no, format, file_name, orig_name, content_type,
              byte_size, width, height, uploaded_by, uploaded_at)
             SELECT ?, zone_no, format, file_name, orig_name, content_type,
                    byte_size, width, height, uploaded_by, uploaded_at
               FROM zone_maps WHERE server_id = ?
           ON DUPLICATE KEY UPDATE zone_no = zone_maps.zone_no`,
          [survivorId, srcId]
        );
        await trx.raw(`DELETE FROM zone_maps WHERE server_id = ?`, [srcId]);

        // scan_sessions — plain re-point (informational snapshot rows).
        await trx.raw(
          `UPDATE scan_sessions SET server_id = ? WHERE server_id = ?`,
          [survivorId, srcId]
        );

        // Delete the non-survivor game_servers row.
        await trx.raw(`DELETE FROM game_servers WHERE id = ?`, [srcId]);
      }

      // Collapse the SURVIVOR's OWN channel<>0 rows into channel 0 (same
      // additive merge, single server). Runs whether or not the group folded.
      await foldChild(trx, 'mob_spawn_cells', survivorId, null,
        CELLS.keyCols, CELLS, CELLS.onDup);
      await foldChild(trx, 'mob_spawn_cell_versions', survivorId, null,
        CELL_VERSIONS.keyCols, CELL_VERSIONS, CELL_VERSIONS.onDup);

      // Stamp survivor name + visible from the roll-ups captured BEFORE the
      // non-survivor deletes above. name: prefer the group's first non-null
      // display_name, else fall back to the survivor's already-seeded name /
      // display_name / the variant. visible: the group OR, so a merged server
      // that had ANY visible constituent stays public on the map.
      await trx.raw(
        `UPDATE game_servers
            SET name = COALESCE(?, name, display_name, ?),
                visible = ?
          WHERE id = ?`,
        [groupDisplayName, variant, groupVisible, survivorId]
      );
    }
  });

  // 6. Drop UNIQUE(ip, variant) on game_servers (guarded). ──────────────────
  //    Knex names it `game_servers_ip_variant_unique`; probe first so a re-run
  //    or a differently-named index is a no-op.
  if (await knex.schema.hasTable('game_servers')) {
    const candidates = ['game_servers_ip_variant_unique'];
    for (const idx of candidates) {
      if (await indexExists(knex, 'game_servers', idx)) {
        try {
          await knex.raw(`ALTER TABLE \`game_servers\` DROP INDEX \`${idx}\``);
        } catch (err) {
          // Best-effort: an FK covering (ip,variant) is not expected here.
          if (err?.code !== 'ER_DROP_INDEX_FK') throw err;
        }
      }
    }
  }
}

// ── down ─────────────────────────────────────────────────────────────────────

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // NOTE: the per-variant row FOLD in up() is NOT reversible — merged servers'
  // heat has been summed and the constituent game_servers rows deleted; they
  // cannot be split back. down() restores SCHEMA ONLY.

  // Re-add UNIQUE(ip, variant). Guard: skip if it already exists, and tolerate
  // a failure caused by residual duplicate (ip,variant) pairs from the fold.
  if (await knex.schema.hasTable('game_servers')) {
    if (!(await indexExists(knex, 'game_servers', 'game_servers_ip_variant_unique'))) {
      try {
        await knex.raw(
          'ALTER TABLE `game_servers` ADD UNIQUE `game_servers_ip_variant_unique` (`ip`, `variant`)'
        );
      } catch (err) {
        if (err?.code !== 'ER_DUP_ENTRY') throw err;
        // Duplicates remain from the fold — cannot restore the constraint.
      }
    }
  }

  // Drop game_servers.name.
  if (await knex.schema.hasTable('game_servers')) {
    if (await knex.schema.hasColumn('game_servers', 'name')) {
      await knex.schema.alterTable('game_servers', (t) => {
        t.dropColumn('name');
      });
    }
  }

  // Drop game_server_hosts.
  if (await knex.schema.hasTable('game_server_hosts')) {
    await knex.schema.dropTable('game_server_hosts');
  }
}
