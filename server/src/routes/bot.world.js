//
// bot.world.js — channel-aware monster-map ingest (PLAN_v2 §3.6, phase P0).
//
//   POST /api/bot/world/spawns       — batch of monster sightings → upsert
//                                       game_servers / mob_catalog / mob_spawn_cells.
//   POST /api/bot/world/zone-bounds  — persist a zone's bounds/origin [B2] from
//                                       the export calibration sidecar [B3].
//
// Middleware order (constraints [D4]/[D2]/[D1]/[D3]):
//   validateSpawnIngest  (auth BEFORE body parse — reject forged requests
//                         before zod walks a ~200-element array)
//     → validate(schema)
//     → resolveUserId     (token.key → licenses.user_id — REUSE the
//                         bot.config.js pattern; there is no resolveBotUser)
//     → load user {role, feature_flags}
//     → gate super_admin || feature_flags.spawn_tracking  (403 else)
//     → v2 ADDITIVE-DELTA upsert: hits = hits + ?, passes = passes + ?,
//       instance_sum = instance_sum + ? via db.raw('... + ?') — NEVER a bare
//       .merge() [D3]. When run_id is present and != the stored last_*_run_id
//       the delta is applied and the run_id stored (distinct-runs guard).
//
// The route-level rate limiter (botWorldLimiter) is applied at mount time in
// index.js, matching how every other bot limiter is wired.
//

import { Router } from 'express';
import db from '../db.js';
import { validateSpawnIngest } from '../middleware/spawnIngest.js';
import { validate, spawnIngestSchema, zoneBoundsSchema } from '../validation/schemas.js';

const router = Router();

function nowSec() { return Math.floor(Date.now() / 1000); }

// ── Auth-context resolution ──────────────────────────────────────────────────
// Mirrors bot.config.js:resolveUserId exactly — accepts session tokens
// (with .key) and, in principle, user tokens (with .user_id). Ingest tokens
// carry .key, so the .key branch is the live one here.
async function resolveUserId(req) {
  const tok = req.botToken;
  if (!tok) return null;
  if (tok.key) {
    const license = await db('licenses').where('license_key', tok.key).first();
    return license?.user_id || null;
  }
  if (tok.type === 'user' && tok.user_id) {
    return tok.user_id;
  }
  return null;
}

// Gate: super_admin bypass OR feature_flags.spawn_tracking [D1]. A naive
// feature_flags.spawn_tracking check would deny super-admins (their stored
// flags may be null / ALL_FEATURES_TRUE is synthetic).
function loadUserAndGate(user) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  let flags = {};
  if (user.feature_flags) {
    try { flags = JSON.parse(user.feature_flags); } catch { flags = {}; }
  }
  return !!flags.spawn_tracking;
}

async function requireSpawnTracking(req, res) {
  const userId = await resolveUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  const user = await db('users').where('id', userId)
    .select('id', 'role', 'feature_flags').first();
  if (!loadUserAndGate(user)) {
    res.status(403).json({ error: 'spawn_tracking not enabled' });
    return null;
  }
  return userId;
}

// Upsert (find or create) the game server for (ip, variant); refresh port +
// last_seen. Returns the numeric server id.
async function upsertGameServer(server) {
  const now = nowSec();
  const existing = await db('game_servers')
    .where({ ip: server.ip, variant: server.variant })
    .first();
  if (existing) {
    const updates = { last_seen: now };
    if (server.port) updates.port = server.port;
    await db('game_servers').where('id', existing.id).update(updates);
    return existing.id;
  }
  const [id] = await db('game_servers').insert({
    ip:           server.ip,
    variant:      server.variant,
    port:         server.port || null,
    display_name: null,
    visible:      false,
    first_seen:   now,
    last_seen:    now,
  });
  return id;
}

// ── POST /spawns ─────────────────────────────────────────────────────────────
router.post('/spawns',
  validateSpawnIngest,
  validate(spawnIngestSchema),
  async (req, res) => {
    const userId = await requireSpawnTracking(req, res);
    if (userId == null) return;

    const { server, zone_no, sightings } = req.validated;
    const now = nowSec();
    const serverId = await upsertGameServer(server);

    // Intra-batch dedup by netid within a (channel, cell, mob) so a single
    // batch that saw the same live instance twice counts it once. netid is
    // used ONLY here and then dropped — never stored, never a key [A8].
    const seenNet = new Set();

    // Aggregate per-cell so N sightings landing in the same cell become one
    // upsert that ADDS the summed deltas, and per-mob catalog stats accumulate.
    // Each drained cell already carries additive *_delta values; we sum them
    // within the batch and hand a single `col = col + ?` to the DB [D3].
    const cellAgg = new Map();   // key → { mob_id, cell_x, cell_z, channel, ySum, wSum, hits, passes, instanceSum, runId }
    const mobAgg  = new Map();   // mob_id → { name, level, maxhp, hits }

    let accepted = 0;
    for (const s of sightings) {
      // [A2] drop unusable/unresolved mob ids — never key on <=0.
      if (!Number.isInteger(s.mob_id) || s.mob_id <= 0) continue;

      const channel = Number.isInteger(s.channel) ? s.channel : 0;

      // Prefer the bot's pre-quantized cell (origin-relative [B1]) so bot + portal
      // grids align; fall back to floor(x/4) only for legacy bots that omit it.
      const cellX = Number.isInteger(s.cell_x) ? s.cell_x : Math.floor(s.x / 4);
      const cellZ = Number.isInteger(s.cell_z) ? s.cell_z : Math.floor(s.z / 4);

      // v2 additive deltas (>= 0, schema-defaulted to 0). At least one is > 0 on
      // a real drain; a legacy migrated cell may send 1/1/1 (low-confidence).
      const hitsD     = Number.isInteger(s.hits_delta)         ? s.hits_delta         : 0;
      const passesD   = Number.isInteger(s.passes_delta)       ? s.passes_delta       : 0;
      const instD     = Number.isInteger(s.instance_sum_delta) ? s.instance_sum_delta : 0;
      // run_id may arrive as a number or a bigint-as-string; carry it as a string
      // for the distinct-runs guard (bigint column). null when absent.
      const runId = s.run_id != null ? String(s.run_id) : null;

      // Weight the y running-mean by observed hits (a cell seen more often
      // contributes more to the height mean); fall back to 1 so a pure-pass or
      // legacy sighting still nudges the mean.
      const yW = hitsD > 0 ? hitsD : 1;

      if (s.netid != null) {
        const netKey = `${channel}|${s.mob_id}|${cellX}|${cellZ}|${s.netid}`;
        if (seenNet.has(netKey)) continue;
        seenNet.add(netKey);
      }

      const cellKey = `${zone_no}|${s.mob_id}|${cellX}|${cellZ}|${channel}`;
      const c = cellAgg.get(cellKey);
      if (c) {
        c.ySum        += s.y * yW;
        c.wSum        += yW;
        c.hits        += hitsD;
        c.passes      += passesD;
        c.instanceSum += instD;
        if (runId != null) c.runId = runId;   // last run_id in the batch for this cell
      } else {
        cellAgg.set(cellKey, {
          mob_id: s.mob_id, cell_x: cellX, cell_z: cellZ, channel,
          ySum: s.y * yW, wSum: yW,
          hits: hitsD, passes: passesD, instanceSum: instD,
          runId,
        });
      }

      const m = mobAgg.get(s.mob_id);
      if (m) {
        if (s.name)  m.name = s.name;                 // latest non-empty name wins for this batch
        if (s.level != null) { m.levelMin = Math.min(m.levelMin ?? s.level, s.level); m.levelMax = Math.max(m.levelMax ?? s.level, s.level); }
        if (s.maxhp != null) { m.maxhpMin = Math.min(m.maxhpMin ?? s.maxhp, s.maxhp); m.maxhpMax = Math.max(m.maxhpMax ?? s.maxhp, s.maxhp); }
        m.hits += hitsD;
      } else {
        mobAgg.set(s.mob_id, {
          name: s.name || null,
          levelMin: s.level ?? null, levelMax: s.level ?? null,
          maxhpMin: s.maxhp ?? null, maxhpMax: s.maxhp ?? null,
          hits: hitsD,
        });
      }
      accepted += 1;
    }

    // ── mob_catalog upsert (widening ranges via LEAST/GREATEST) ─────────────
    // sightings_total accumulates the summed hit deltas (NOT passes) so it tracks
    // "times seen" and stays coherent with the per-cell `hits`.
    for (const [mobId, m] of mobAgg) {
      const insertRow = {
        server_id:       serverId,
        mob_id:          mobId,
        name:            m.name,
        level_min:       m.levelMin,
        level_max:       m.levelMax,
        maxhp_min:       m.maxhpMin,
        maxhp_max:       m.maxhpMax,
        sightings_total: m.hits,
        last_seen:       now,
      };
      // COALESCE so an all-NULL existing bound doesn't swallow a new value,
      // and a NULL incoming value doesn't wipe an existing bound.
      await db('mob_catalog')
        .insert(insertRow)
        .onConflict(['server_id', 'mob_id'])
        .merge({
          name:            db.raw('COALESCE(VALUES(name), mob_catalog.name)'),
          level_min:       db.raw('LEAST(COALESCE(mob_catalog.level_min, VALUES(level_min)), COALESCE(VALUES(level_min), mob_catalog.level_min))'),
          level_max:       db.raw('GREATEST(COALESCE(mob_catalog.level_max, VALUES(level_max)), COALESCE(VALUES(level_max), mob_catalog.level_max))'),
          maxhp_min:       db.raw('LEAST(COALESCE(mob_catalog.maxhp_min, VALUES(maxhp_min)), COALESCE(VALUES(maxhp_min), mob_catalog.maxhp_min))'),
          maxhp_max:       db.raw('GREATEST(COALESCE(mob_catalog.maxhp_max, VALUES(maxhp_max)), COALESCE(VALUES(maxhp_max), mob_catalog.maxhp_max))'),
          sightings_total: db.raw('mob_catalog.sightings_total + VALUES(sightings_total)'),
          last_seen:       now,
        });
    }

    // ── mob_spawn_cells upsert (ADDITIVE deltas, running-mean y_avg) ────────
    // NEVER a bare .merge() [D3]. hits/passes/instance_sum are ADDED via
    // db.raw('col + ?') so the portal never re-adds a cumulative total (the fix
    // for super-linear inflation). y_avg is a hits-weighted running mean over the
    // total observation weight (hits + passes) so old cells converge on the true
    // height. When a run_id is present and differs from the stored last_*_run_id
    // the hit/pass delta is applied and the run_id stored — keeping the counters
    // distinct-runs (a re-sent batch for the same run adds nothing).
    //
    // v3 (STEP 3): in the SAME transaction, every cell that CARRIES a run_id
    // ALSO writes a per-version row into mob_spawn_cell_versions (version_id =
    // run_id) + bumps spawn_version_meta. The all-time upsert below is
    // UNCHANGED in SQL/semantics — the versioned write is strictly additional,
    // and a cell WITHOUT a run_id writes ONLY the all-time table (legacy
    // preserved). The whole cell write set runs inside one db.transaction so
    // the all-time and versioned rows commit atomically.
    await db.transaction(async (trx) => {
      // Per-(server,zone,version) meta accumulator: widen [start,end] window and
      // count how many cell rows fed the version this ingest.
      const verMeta = new Map();  // version → { start, end, runCount }

      for (const [, c] of cellAgg) {
        const wSum  = c.wSum > 0 ? c.wSum : 1;
        const yMean = c.ySum / wSum;
        // Total observation weight of this cell = hits + passes (both are events
        // that touched the cell). Used to weight the running-mean denominator so
        // pure-pass cells still contribute to the height estimate.
        const obsW  = (c.hits + c.passes) > 0 ? (c.hits + c.passes) : 1;
        const runId = c.runId;   // string | null

        // run_id-guarded delta expressions. With a run_id: apply the delta only
        // when it differs from the stored last_*_run_id (distinct-runs), and store
        // the new run_id. Without a run_id (bot omits it today): always add.
        const hitsExpr = runId != null
          ? trx.raw('mob_spawn_cells.hits + (CASE WHEN mob_spawn_cells.last_hit_run_id <> ? THEN ? ELSE 0 END)', [runId, c.hits])
          : trx.raw('mob_spawn_cells.hits + ?', [c.hits]);
        const passesExpr = runId != null
          ? trx.raw('mob_spawn_cells.passes + (CASE WHEN mob_spawn_cells.last_pass_run_id <> ? THEN ? ELSE 0 END)', [runId, c.passes])
          : trx.raw('mob_spawn_cells.passes + ?', [c.passes]);

        const mergeSet = {
          hits:          hitsExpr,
          passes:        passesExpr,
          instance_sum:  trx.raw('mob_spawn_cells.instance_sum + ?', [c.instanceSum]),
          last_seen_sec: now,
          // Weighted running mean: (oldMean*oldW + batchMean*batchW)/(oldW+batchW),
          // where W = hits+passes accumulated in the row so far.
          y_avg: trx.raw(
            '(COALESCE(mob_spawn_cells.y_avg,0) * (mob_spawn_cells.hits + mob_spawn_cells.passes) + ?) / GREATEST(mob_spawn_cells.hits + mob_spawn_cells.passes + ?, 1)',
            [yMean * obsW, obsW],
          ),
        };
        if (runId != null) {
          // Store the run_id only on the dimension whose delta we actually applied.
          mergeSet.last_hit_run_id  = trx.raw('CASE WHEN mob_spawn_cells.last_hit_run_id  <> ? THEN ? ELSE mob_spawn_cells.last_hit_run_id  END', [runId, runId]);
          mergeSet.last_pass_run_id = trx.raw('CASE WHEN mob_spawn_cells.last_pass_run_id <> ? THEN ? ELSE mob_spawn_cells.last_pass_run_id END', [runId, runId]);
        }

        await trx('mob_spawn_cells')
          .insert({
            server_id:        serverId,
            zone_no,
            mob_id:           c.mob_id,
            cell_x:           c.cell_x,
            cell_z:           c.cell_z,
            channel:          c.channel,
            y_avg:            yMean,
            hits:             c.hits,
            passes:           c.passes,
            instance_sum:     c.instanceSum,
            last_hit_run_id:  runId ?? 0,
            last_pass_run_id: runId ?? 0,
            first_seen_sec:   now,
            last_seen_sec:    now,
          })
          .onConflict(['server_id', 'zone_no', 'mob_id', 'cell_x', 'cell_z', 'channel'])
          .merge(mergeSet);

        // ── v3 per-version upsert (ONLY when the cell carries a run_id) ──────
        // version_id = run_id used DIRECTLY as the bucket. Same additive-delta,
        // run_id-guarded shape as the all-time path, keyed on the 7-col spot key
        // (spot key + version_id). A cell without a run_id skips this entirely —
        // legacy all-time-only preserved.
        if (runId != null) {
          const verHitsExpr = trx.raw(
            'mob_spawn_cell_versions.hits + (CASE WHEN mob_spawn_cell_versions.last_hit_run_id <> ? THEN ? ELSE 0 END)',
            [runId, c.hits],
          );
          const verPassesExpr = trx.raw(
            'mob_spawn_cell_versions.passes + (CASE WHEN mob_spawn_cell_versions.last_pass_run_id <> ? THEN ? ELSE 0 END)',
            [runId, c.passes],
          );
          await trx('mob_spawn_cell_versions')
            .insert({
              server_id:        serverId,
              zone_no,
              mob_id:           c.mob_id,
              cell_x:           c.cell_x,
              cell_z:           c.cell_z,
              channel:          c.channel,
              version_id:       runId,
              hits:             c.hits,
              passes:           c.passes,
              instance_sum:     c.instanceSum,
              last_hit_run_id:  runId,
              last_pass_run_id: runId,
              y_avg:            yMean,
              first_seen_sec:   now,
              last_seen_sec:    now,
            })
            .onConflict(['server_id', 'zone_no', 'mob_id', 'cell_x', 'cell_z', 'channel', 'version_id'])
            .merge({
              hits:             verHitsExpr,
              passes:           verPassesExpr,
              instance_sum:     trx.raw('mob_spawn_cell_versions.instance_sum + ?', [c.instanceSum]),
              last_seen_sec:    now,
              y_avg:            trx.raw(
                '(COALESCE(mob_spawn_cell_versions.y_avg,0) * (mob_spawn_cell_versions.hits + mob_spawn_cell_versions.passes) + ?) / GREATEST(mob_spawn_cell_versions.hits + mob_spawn_cell_versions.passes + ?, 1)',
                [yMean * obsW, obsW],
              ),
              last_hit_run_id:  trx.raw('CASE WHEN mob_spawn_cell_versions.last_hit_run_id  <> ? THEN ? ELSE mob_spawn_cell_versions.last_hit_run_id  END', [runId, runId]),
              last_pass_run_id: trx.raw('CASE WHEN mob_spawn_cell_versions.last_pass_run_id <> ? THEN ? ELSE mob_spawn_cell_versions.last_pass_run_id END', [runId, runId]),
            });

          // Accumulate this version's observation window (first/last seen = now
          // for this ingest) and a run-count bump.
          const vm = verMeta.get(runId);
          if (vm) {
            if (now < vm.start) vm.start = now;
            if (now > vm.end)   vm.end   = now;
            vm.runCount += 1;
          } else {
            verMeta.set(runId, { start: now, end: now, runCount: 1 });
          }
        }
      }

      // ── spawn_version_meta upsert (per (server,zone,version)) ─────────────
      // ver_start widens to the MIN first_seen, ver_end to the MAX last_seen,
      // run_count bumps by the number of cell rows this ingest fed the version.
      for (const [version, vm] of verMeta) {
        await trx('spawn_version_meta')
          .insert({
            server_id:     serverId,
            zone_no,
            version_id:    version,
            ver_start_sec: vm.start,
            ver_end_sec:   vm.end,
            run_count:     vm.runCount,
            updated_at:    now,
            // Recorder id (032). RESOLVED server-side from the license
            // (requireSpawnTracking → userId), NEVER a client body field. Stamped
            // on INSERT ONLY — the .merge() below deliberately omits user_id so
            // the FIRST writer of a (server,zone,version) owns the recorder slot
            // (first-writer-wins). A NULL userId (shouldn't happen past the gate)
            // simply leaves the slot NULL.
            user_id:       userId ?? null,
          })
          .onConflict(['server_id', 'zone_no', 'version_id'])
          .merge({
            ver_start_sec: trx.raw('LEAST(spawn_version_meta.ver_start_sec, ?)', [vm.start]),
            ver_end_sec:   trx.raw('GREATEST(spawn_version_meta.ver_end_sec, ?)', [vm.end]),
            run_count:     trx.raw('spawn_version_meta.run_count + ?', [vm.runCount]),
            updated_at:    now,
          });
      }
    });

    res.json({
      ok: true,
      server_id: serverId,
      accepted,
      cells: cellAgg.size,
      mobs:  mobAgg.size,
    });
  });

// ── POST /zone-bounds ────────────────────────────────────────────────────────
// Persist bounds/origin captured at export time [B2][B3]. Latest-wins upsert.
router.post('/zone-bounds',
  validateSpawnIngest,
  validate(zoneBoundsSchema),
  async (req, res) => {
    const userId = await requireSpawnTracking(req, res);
    if (userId == null) return;

    const b = req.validated;
    const now = nowSec();
    const serverId = await upsertGameServer(b.server);

    await db('zone_bounds')
      .insert({
        server_id:        serverId,
        zone_no:          b.zone_no,
        origin_x:         b.origin_x,
        origin_z:         b.origin_z,
        world_min_x:      b.world_min_x,
        world_min_z:      b.world_min_z,
        world_max_x:      b.world_max_x,
        world_max_z:      b.world_max_z,
        size_px:          b.size_px ?? null,
        meters_per_pixel: b.meters_per_pixel ?? null,
        cell_size_m:      b.cell_size_m ?? 4,
        updated_at:       now,
      })
      .onConflict(['server_id', 'zone_no'])
      .merge({
        origin_x:         b.origin_x,
        origin_z:         b.origin_z,
        world_min_x:      b.world_min_x,
        world_min_z:      b.world_min_z,
        world_max_x:      b.world_max_x,
        world_max_z:      b.world_max_z,
        size_px:          b.size_px ?? null,
        meters_per_pixel: b.meters_per_pixel ?? null,
        cell_size_m:      b.cell_size_m ?? 4,
        updated_at:       now,
      });

    res.json({ ok: true, server_id: serverId, zone_no: b.zone_no });
  });

export default router;
