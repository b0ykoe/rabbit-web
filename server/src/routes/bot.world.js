//
// bot.world.js — channel-aware monster-map ingest (PLAN_v2 §3.6, phase P0).
//
//   POST /api/bot/world/spawns       — batch of monster sightings → upsert
//                                       game_servers / mob_catalog / mob_spawn_cells.
//
// Zone bounds/origin are NOT ingested here: they are set by a super_admin who
// uploads the bot's export calibration sidecar (calib.json) via
// POST /api/admin/world/servers/:id/zones/:zoneNo/bounds (admin.world.js),
// matching the admin-only-upload security model used for names + background maps.
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

import crypto from 'node:crypto';
import { Router } from 'express';
import db from '../db.js';
import { validateSpawnIngest } from '../middleware/spawnIngest.js';
import {
  validate, spawnIngestSchema,
  sessionStartSchema, sessionStopSchema,
} from '../validation/schemas.js';

const router = Router();

function nowSec() { return Math.floor(Date.now() / 1000); }

// Stale 'running' sessions older than this (seconds) are lazily flipped to
// 'expired' when they are read — a bot that died without POSTing /session/stop
// (crash, kill) doesn't leave a session 'running' forever. 12h.
const SESSION_STALE_SEC = 12 * 60 * 60;

// LAZY EXPIRY. Called on the read paths (session load). If the row is still
// 'running' but older than SESSION_STALE_SEC, flip it to 'expired' in place and
// return the mutated view so the caller sees the effective status. Cheap +
// best-effort — a concurrent stop simply wins the last write.
async function lazyExpireSession(row) {
  if (!row) return row;
  if (row.status === 'running') {
    const now = nowSec();
    if (now - Number(row.started_sec) > SESSION_STALE_SEC) {
      await db('scan_sessions')
        .where('session_id', row.session_id)
        .andWhere('status', 'running')
        .update({ status: 'expired', ended_sec: now, updated_at: now });
      return { ...row, status: 'expired', ended_sec: now, updated_at: now };
    }
  }
  return row;
}

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

// Resolve the effective server_id for an ingest body (034 named-server model).
// Servers are ADMIN-DEFINED now — the bot never auto-creates one. Resolution
// order:
//   1. validated.server_id present → verify it exists in game_servers; else null
//      (the caller decides the HTTP status: 404/422 on a hard-required path,
//      null-tolerant on session/start).
//   2. else validated.server{ip,variant} hint present → resolve WITHOUT creating:
//        a. game_server_hosts.ip == server.ip → its server_id (host-map wins)
//        b. else a game_servers row with variant == server.variant (MIN id)
//        c. else null (no matching admin-defined server)
//   3. else null.
// Returns { id, notFound } where notFound is true ONLY when a server_id was
// explicitly supplied but does not exist (so the caller can 404/422); a hint
// that fails to resolve returns { id: null, notFound: false }.
async function resolveServerId(validated) {
  if (validated.server_id != null) {
    const row = await db('game_servers').where('id', validated.server_id).select('id').first();
    return { id: row ? row.id : null, notFound: !row };
  }

  const server = validated.server;
  if (server && server.ip) {
    // (a) host-map: an admin has registered this exact game socket IP.
    const host = await db('game_server_hosts')
      .where('ip', server.ip)
      .select('server_id')
      .first();
    if (host) return { id: host.server_id, notFound: false };
  }
  if (server && server.variant) {
    // (b) fall back to the MIN-id server for this variant (post-034 fold there
    // is one row per variant, so this is deterministic).
    const byVariant = await db('game_servers')
      .where('variant', server.variant)
      .min('id as id')
      .first();
    if (byVariant && byVariant.id != null) return { id: byVariant.id, notFound: false };
  }
  return { id: null, notFound: false };
}

// ── GET /servers ─────────────────────────────────────────────────────────────
// Bot-facing server directory (034). The bot fetches this to populate its
// Server dropdown and to PRESELECT by (variant, ip). Auth = the SAME ingest
// middleware as POST /spawns (token via Authorization: Bearer header since a GET
// carries no body) + the spawn_tracking gate.
//
//   Query (optional): ip=<str> variant=<str>
//   200 → { servers: [ { server_id, name, variant, known_ips:[...] } ],
//           preselect_server_id: <int|null> }
//
// Only visible=true servers are returned. preselect: rows whose variant ==
// query.variant AND that own query.ip in game_server_hosts. EXACTLY one match →
// its server_id; zero or ≥2 → null.
router.get('/servers',
  validateSpawnIngest,
  async (req, res) => {
    const userId = await requireSpawnTracking(req, res);
    if (userId == null) return;

    const qIp      = typeof req.query.ip === 'string' ? req.query.ip.trim() : '';
    const qVariant = typeof req.query.variant === 'string' ? req.query.variant.trim() : '';

    // Visible servers only.
    const servers = await db('game_servers')
      .where('visible', true)
      .select('id', 'name', 'variant', 'display_name')
      .orderBy('name', 'asc')
      .limit(500);

    // Flatten known IPs per server (game_server_hosts). One grouped read, then
    // fan out into per-server lists so a server with no hosts still returns [].
    const ipsByServer = new Map();
    if (servers.length) {
      const ids = servers.map(s => s.id);
      const hostRows = await db('game_server_hosts')
        .whereIn('server_id', ids)
        .whereNotNull('ip')
        .select('server_id', 'ip');
      for (const h of hostRows) {
        if (!ipsByServer.has(h.server_id)) ipsByServer.set(h.server_id, []);
        ipsByServer.get(h.server_id).push(h.ip);
      }
    }

    const out = servers.map(s => ({
      server_id: s.id,
      // name is the admin label; fall back to display_name then a synthetic tag.
      name:      s.name || s.display_name || `Server #${s.id}`,
      variant:   s.variant,
      known_ips: ipsByServer.get(s.id) || [],
    }));

    // Preselect: exactly-one server whose variant matches AND owns qIp.
    let preselectServerId = null;
    if (qVariant && qIp) {
      const matches = out.filter(
        s => s.variant === qVariant && s.known_ips.includes(qIp),
      );
      if (matches.length === 1) preselectServerId = matches[0].server_id;
    }

    res.json({ servers: out, preselect_server_id: preselectServerId });
  });

// ── GET /servers/:id/offset-blob ─────────────────────────────────────────────
// Bot-facing serve of a server's SIGNED offset blob (Phase D/E). Auth = the SAME
// ingest middleware as /spawns (validateSpawnIngest → spawn_tracking gate; token
// via Authorization: Bearer since a GET carries no body). The blob's ed25519
// signature — verified by the bot with its COMPILED pubkey — is the tamper gate,
// so the stored blob is safe to serve to any authed bot verbatim. 404 when the
// server has no signed blob yet (unsigned).
//
//   200 → the parsed { payload_b64, signature_b64 } object.
//   404 → { error: 'no signed offsets' }  (server missing OR blob unsigned).
router.get('/servers/:id/offset-blob',
  validateSpawnIngest,
  async (req, res) => {
    const userId = await requireSpawnTracking(req, res);
    if (userId == null) return;

    const serverId = parseInt(req.params.id, 10);
    if (!Number.isFinite(serverId) || serverId < 0) {
      return res.status(400).json({ error: 'Bad server id' });
    }

    const server = await db('game_servers')
      .where('id', serverId)
      .select('offset_signed_blob')
      .first();
    if (!server || server.offset_signed_blob == null) {
      return res.status(404).json({ error: 'no signed offsets' });
    }

    // Stored as JSON.stringify({payload_b64,signature_b64}); parse it back so the
    // bot receives the object directly. A malformed stored blob (shouldn't happen
    // — it was written by buildBlob) is treated as unsigned.
    let blob;
    try { blob = JSON.parse(server.offset_signed_blob); }
    catch { return res.status(404).json({ error: 'no signed offsets' }); }

    res.json(blob);
  });

// ── POST /spawns ─────────────────────────────────────────────────────────────
router.post('/spawns',
  validateSpawnIngest,
  validate(spawnIngestSchema),
  async (req, res) => {
    const userId = await requireSpawnTracking(req, res);
    if (userId == null) return;

    const { zone_no, sightings, session_id } = req.validated;
    const now = nowSec();

    // Resolve the admin-defined named server (034). A supplied-but-unknown
    // server_id hard-fails (404); a missing/unresolvable hint is a 400 — ingest
    // requires a real server row (the bot HARD-BLOCKS recording until one is
    // selected, so a live upload always carries a resolvable identity).
    const resolved = await resolveServerId(req.validated);
    if (resolved.notFound) {
      return res.status(404).json({ error: 'Unknown server_id' });
    }
    const serverId = resolved.id;
    if (serverId == null) {
      return res.status(400).json({ error: 'Could not resolve server (provide server_id)' });
    }

    // ── Resolve the effective session_id (null-tolerant) ────────────────────
    // A batch may carry a backend session_id (033). We stamp it on the
    // spawn_version_meta INSERT (first-writer-wins) ONLY when the session both
    // exists AND is owned by the resolving user. A missing/foreign/stale
    // session_id is DROPPED (effSessionId = null) — ingest never hard-rejects
    // on it, matching the additive/back-compat contract. Lazy-expiry runs on
    // the read but does NOT gate the stamp (an expired-but-owned session still
    // attributes its already-in-flight deltas).
    let effSessionId = null;
    if (session_id) {
      const sess = await lazyExpireSession(
        await db('scan_sessions').where('session_id', session_id).first(),
      );
      if (sess && sess.user_id === userId) effSessionId = session_id;
    }

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

      // 034: the channel dimension is REMOVED — every cell collapses to channel 0.
      // s.channel (if the bot still sends it) is IGNORED here so all data lands in
      // the single agnostic bucket. netid dedup still uses a per-cell scope.
      const channel = 0;

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
            // Backend session back-reference (033). Same first-writer-wins
            // discipline as user_id: stamped on INSERT ONLY (omitted from the
            // .merge() below), so the FIRST writer of a (server,zone,version)
            // owns the session slot. null when the batch carried no owned/valid
            // session_id.
            session_id:    effSessionId,
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

// ── POST /session/start ──────────────────────────────────────────────────────
// Open a backend recording session. Same guards as /spawns (auth BEFORE body
// parse → schema → spawn_tracking gate → resolved userId). The portal mints the
// session_id (crypto.randomUUID) so the bot never has to; the bot rides it
// alongside run_id on subsequent /spawns uploads. server{}/zone_no/run_id are
// all optional (a Debug-with-key start may not know the server yet).
router.post('/session/start',
  validateSpawnIngest,
  validate(sessionStartSchema),
  async (req, res) => {
    const userId = await requireSpawnTracking(req, res);
    if (userId == null) return;

    const { server, zone_no, run_id } = req.validated;
    const now = nowSec();

    // Resolve the admin-defined named server (034) — NULL-TOLERANT here: a
    // session may open before the bot knows/selects a server. A supplied-but-
    // unknown server_id still hard-fails so a bad id is never silently dropped;
    // a missing/unresolvable hint just leaves serverId null. The ip/variant
    // snapshot comes from the optional server{} hint when present.
    const resolved = await resolveServerId(req.validated);
    if (resolved.notFound) {
      return res.status(404).json({ error: 'Unknown server_id' });
    }
    const serverId = resolved.id;   // may be null (no server yet)
    let ip = null;
    let variant = null;
    if (server) {
      ip = server.ip;
      variant = server.variant;
    }

    const sessionId = crypto.randomUUID();
    await db('scan_sessions').insert({
      session_id:  sessionId,
      user_id:     userId ?? null,
      server_id:   serverId,
      ip,
      variant,
      // run_id carried as a string for the bigint column (JSON can't hold a bigint).
      run_id:      run_id != null ? String(run_id) : null,
      zone_no:     zone_no ?? null,
      status:      'running',
      started_sec: now,
      ended_sec:   null,
      updated_at:  now,
    });

    res.json({ ok: true, session_id: sessionId, started_sec: now });
  });

// ── POST /session/stop ───────────────────────────────────────────────────────
// Close a recording session by its uuid. 404 on unknown. Ownership guard:
// row.user_id === userId, with a super_admin bypass (super_admin may stop any
// session). ended_sec is server-clamped to [started, now]. Idempotent: a session
// already stopped/expired returns ok with its existing ended_sec unchanged.
router.post('/session/stop',
  validateSpawnIngest,
  validate(sessionStopSchema),
  async (req, res) => {
    const userId = await requireSpawnTracking(req, res);
    if (userId == null) return;

    const { session_id, ended_sec } = req.validated;

    // Lazy-expire on read so a stale 'running' row reports correctly even here.
    let row = await lazyExpireSession(
      await db('scan_sessions').where('session_id', session_id).first(),
    );
    if (!row) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }

    // Ownership: the recording user, OR a super_admin (may stop ANY session).
    const actor = await db('users').where('id', userId).select('role').first();
    const isSuperAdmin = actor?.role === 'super_admin';
    if (!isSuperAdmin && row.user_id !== userId) {
      res.status(403).json({ error: 'Not your session' });
      return;
    }

    const now = nowSec();

    // Idempotent: already-closed sessions return their existing ended_sec.
    if (row.status !== 'running') {
      res.json({ ok: true, session_id: row.session_id, ended_sec: row.ended_sec });
      return;
    }

    // Clamp the requested end into [started_sec, now]; default to now.
    const started = Number(row.started_sec);
    let ended = ended_sec != null ? ended_sec : now;
    if (ended < started) ended = started;
    if (ended > now)     ended = now;

    await db('scan_sessions')
      .where('session_id', session_id)
      .andWhere('status', 'running')
      .update({ status: 'stopped', ended_sec: ended, updated_at: now });

    res.json({ ok: true, session_id, ended_sec: ended });
  });

export default router;
