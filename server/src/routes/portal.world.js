//
// portal.world.js — monster-map read API (PLAN_v2 §3.6, PLAN.md §1).
//
// Mounted at /api/portal/world — portal SESSION auth (the whole /api/portal
// tree is force-authed at index.js) [E7]. Choosing the auth-only prefix now
// is free; going public later is a route re-mount under /api/world, not a
// one-line toggle. All read paths are hard-LIMITed server-side [E2][E6].
//
//   GET /servers                                   — visible servers + counts
//   GET /:serverId/mobs?q=                          — catalog search, sightings DESC
//   GET /:serverId/zones/:zoneNo/spawns?mob_id=&channel=&ignore_channels=
//                                                   — cells for a zone (channel filter
//                                                     `= N OR = 0` [FIX]); no mob_id →
//                                                     SUM(hits) density GROUP BY cell
//   GET /:serverId/mobs/:mobId/spawns               — all zones for a mob
//   GET /:serverId/channels                         — distinct channels (ignore UI)
//   GET /:serverId/zones/:zoneNo/clusters?mob_id=&channel=
//                                                   — 8-neighbour connected-cell packs
//
// v2 heat is ADDITIVE (hits/passes/instance_sum). Confidence + group size are
// computed ON READ, never stored:
//   reliability   = (hits+1)/(passes+2)      — Laplace-smoothed seen-rate [0..1+]
//   typical_group = instance_sum/MAX(hits,1) — mean concurrent instances
//   density_score = reliability * typical_group  — the ranking key (was count)
// Every heat path RANKs/ORDERs BY density_score DESC behind a hard LIMIT, and
// returns reliability + typical_group so the client can rank/grey low-confidence.
//

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { config } from '../config.js';

const router = Router();

// ── Session-user helpers (mirror middleware/auth.js) ─────────────────────────
// The whole /api/portal tree is force-authed, so req.session.user is present on
// every route below. These read that same session shape used across the portal
// routes (portal.shop.js etc.) — id + role. No new auth surface.
function sessionUserId(req)   { return req.session?.user?.id ?? null; }
function sessionRole(req)     { return req.session?.user?.role ?? null; }
function reqIsAdmin(req)      { const r = sessionRole(req); return r === 'admin' || r === 'super_admin'; }
function reqIsSuperAdmin(req) { return sessionRole(req) === 'super_admin'; }

// A visible-server guard shared by the new session-scoped reads. Non-admins may
// only touch servers with game_servers.visible=true (servers are SHARED — there
// is NO owner_id). Admins bypass the visibility gate. Returns true when the
// caller may read (serverId), false → the route 403s. Mirrors the /servers scope.
async function callerMaySeeServer(req, serverId) {
  if (reqIsAdmin(req)) {
    const row = await db('game_servers').where('id', serverId).select('id').first();
    return !!row;
  }
  const row = await db('game_servers')
    .where({ id: serverId, visible: true })
    .select('id')
    .first();
  return !!row;
}

// Hard caps for the new session-scoped reads.
const SESSIONS_LIMIT     = 200;   // spawn_version_meta rows per /sessions call
const COVERAGE_ZONE_LIMIT = 512;  // zones per /coverage call
const DIFF_LIST_LIMIT    = 2000;  // capped spot list returned by /diff
const DETAIL_CELL_SCAN   = 20000; // cells scanned per /sessions/:v/detail (mirror CLUSTER_CELL_SCAN)
const DETAIL_SPOT_LIMIT  = 500;   // spots returned per /sessions/:v/detail (mirror CLUSTER_LIMIT)

// Zone background-map image storage dir (mirrors admin.world.js — same
// BOT_PRIVATE_DIR-rooted filesystem convention as Releases).
const ZONE_MAP_DIR = path.join(config.bot.privateDir, 'zone_maps');

// Hard row caps — every path is bounded so a huge zone / months of
// accumulation can never return an unbounded payload [E2][E6].
const CELL_LIMIT     = 5000;
const MOB_LIMIT      = 200;
const CLUSTER_LIMIT  = 500;
const CLUSTER_CELL_SCAN = 20000;   // ceiling on cells fed to the agglomeration

// ── v2 computed-on-read heat expressions ─────────────────────────────────────
// Kept as raw SQL fragments so a per-row select and a post-GROUP HAVING/ORDER
// share one definition. reliability is Laplace-smoothed so a never-passed cell
// (passes=0) still yields a finite score; typical_group guards hits=0.
//   reliability   = (hits+1)/(passes+2)
//   typical_group = instance_sum/GREATEST(hits,1)
//   density_score = reliability * typical_group
const REL_EXPR     = '((`hits` + 1) / (`passes` + 2))';
const GROUP_EXPR   = '(`instance_sum` / GREATEST(`hits`, 1))';
const DENSITY_EXPR = `${REL_EXPR} * ${GROUP_EXPR}`;
// Aggregated forms for the density GROUP BY (operate on the per-cell SUMs).
const REL_AGG      = '((SUM(`hits`) + 1) / (SUM(`passes`) + 2))';
const GROUP_AGG    = '(SUM(`instance_sum`) / GREATEST(SUM(`hits`), 1))';
const DENSITY_AGG  = `${REL_AGG} * ${GROUP_AGG}`;

function intParam(v, dflt = null) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

// ── Shared 8-neighbour cell agglomeration ────────────────────────────────────
// The single source of truth for growing a sparse set of cells into connected
// "packs". Used by BOTH the /clusters route and the new /sessions/:v/detail
// route so the spot definition never diverges. Input cells must expose
// {cell_x, cell_z, hits, passes, instance_sum, y_avg}; each may also carry an
// arbitrary payload the caller folds per-cell via onCell(cluster, cell).
//
// Returns an array of packs, each with the summed v2 counters + computed
// reliability/typical_group/density_score, cell centroid, and bbox. Callers add
// world-coord centers / change status on top; the geometry + heat live here.
function agglomerateCells(cells, onCell = null) {
  const key = (x, z) => `${x}|${z}`;
  const index = new Map();
  for (const c of cells) index.set(key(c.cell_x, c.cell_z), c);
  const visited = new Set();
  const clusters = [];

  for (const c of cells) {
    const k0 = key(c.cell_x, c.cell_z);
    if (visited.has(k0)) continue;

    // BFS from this seed.
    const stack = [c];
    visited.add(k0);
    let sumHits = 0, sumPasses = 0, sumInst = 0, cellCount = 0, ySum = 0, yN = 0;
    let minX = c.cell_x, maxX = c.cell_x, minZ = c.cell_z, maxZ = c.cell_z;
    let cxSum = 0, czSum = 0;
    const cluster = {};

    while (stack.length) {
      const cur = stack.pop();
      sumHits   += cur.hits;
      sumPasses += cur.passes;
      sumInst   += cur.instance_sum;
      cellCount += 1;
      cxSum += cur.cell_x; czSum += cur.cell_z;
      if (cur.y_avg != null) { ySum += cur.y_avg; yN += 1; }
      if (cur.cell_x < minX) minX = cur.cell_x;
      if (cur.cell_x > maxX) maxX = cur.cell_x;
      if (cur.cell_z < minZ) minZ = cur.cell_z;
      if (cur.cell_z > maxZ) maxZ = cur.cell_z;
      if (onCell) onCell(cluster, cur);

      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dz === 0) continue;
          const nk = key(cur.cell_x + dx, cur.cell_z + dz);
          if (visited.has(nk)) continue;
          const nb = index.get(nk);
          if (nb) { visited.add(nk); stack.push(nb); }
        }
      }
    }

    // Pack-level v2 heat, computed from the summed counters (same formulas as
    // the per-cell read path).
    const reliability   = (sumHits + 1) / (sumPasses + 2);
    const typicalGroup  = sumInst / Math.max(sumHits, 1);
    const densityScore  = reliability * typicalGroup;

    cluster.cells         = cellCount;
    cluster.total_count   = sumHits;          // kept for back-compat = Σ hits in the pack
    cluster.hits          = sumHits;
    cluster.passes        = sumPasses;
    cluster.instance_sum  = sumInst;
    cluster.reliability   = reliability;
    cluster.typical_group = typicalGroup;
    cluster.density_score = densityScore;
    cluster.center_x      = Math.round(cxSum / cellCount);
    cluster.center_z      = Math.round(czSum / cellCount);
    cluster.min_x = minX; cluster.max_x = maxX; cluster.min_z = minZ; cluster.max_z = maxZ;
    cluster.y_avg         = yN ? ySum / yN : null;
    clusters.push(cluster);
  }
  return clusters;
}

// Parse the optional ?version query for the versioned-spots read (STEP 3).
// Returns one of:
//   { kind: 'all' }                 — no param, or ?version=all → all-time (legacy) path
//   { kind: 'latest' }              — newest revision per spot from the versioned table
//   { kind: 'exact', version: <s> } — one exact version bucket (bigint as string)
//   null                            — malformed value → the route 400s
// A bigint version is carried as a STRING (JS can't hold the full bigint range),
// which is exactly what a knex bound param wants for a BIGINT column.
function parseVersionParam(v) {
  if (v == null || v === '') return { kind: 'all' };
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'all')    return { kind: 'all' };
  if (s === 'latest') return { kind: 'latest' };
  if (/^\d+$/.test(s)) return { kind: 'exact', version: s };
  return null;
}

// Parse a comma-separated int list ("3,5,7") → [3,5,7], capped + sanitized.
function intList(v, max = 64) {
  if (typeof v !== 'string' || !v) return [];
  return v.split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n))
    .slice(0, max);
}

// ── Versioned-spots read helper (STEP 3) ─────────────────────────────────────
// Backs GET /:serverId/zones/:zoneNo/spawns?version=latest|<number>. Reads from
// mob_spawn_cell_versions (never the all-time table). Density formulas match the
// all-time per-cell path so the client can rank identically; every row also
// returns version_id + last_seen_sec so age is derived client-side.
//
// 'latest' = newest revision PER SPOT (6-col spot key), via a ROW_NUMBER window
// (MySQL 8 equivalent of Postgres DISTINCT ON): rank rows within each spot by
// version_id DESC and keep rn=1. '<number>' = one exact version bucket.
async function handleVersionedSpawns({ res, serverId, zoneNo, mobId, channel, ignoreChannels, version }) {
  // Channel filter as a raw WHERE fragment (this path uses a wrapped subquery so
  // the knex builder helper for the outer query is not reused here).
  const channelClauses = [];
  const channelBinds   = [];
  if (channel != null) {
    channelClauses.push('(channel = ? OR channel = 0)');
    channelBinds.push(channel);
  }
  if (ignoreChannels.length) {
    channelClauses.push(`channel NOT IN (${ignoreChannels.map(() => '?').join(',')})`);
    channelBinds.push(...ignoreChannels);
  }
  const channelSql = channelClauses.length ? ` AND ${channelClauses.join(' AND ')}` : '';

  // Base predicate: always server+zone; mob_id when the caller restricts to one.
  const baseClauses = ['server_id = ?', 'zone_no = ?'];
  const baseBinds   = [serverId, zoneNo];
  if (mobId != null) { baseClauses.push('mob_id = ?'); baseBinds.push(mobId); }

  // Version predicate: exact bucket → WHERE version_id = ?. For 'latest' the
  // newest-per-spot selection happens in the window layer, so no extra filter.
  let versionWhereSql = '';
  const versionBinds  = [];
  if (version.kind === 'exact') {
    versionWhereSql = ' AND version_id = ?';
    versionBinds.push(version.version);
  }

  const whereSql = `${baseClauses.join(' AND ')}${channelSql}${versionWhereSql}`;
  const whereBinds = [...baseBinds, ...channelBinds, ...versionBinds];

  // Computed heat columns (same formulas as the all-time per-cell path).
  const selectCols =
    'mob_id, cell_x, cell_z, channel, version_id, y_avg, hits, passes, instance_sum, last_seen_sec, ' +
    `${REL_EXPR} as reliability, ${GROUP_EXPR} as typical_group, ${DENSITY_EXPR} as density_score`;

  let sql;
  let binds;
  if (version.kind === 'latest') {
    // Newest revision per spot. ROW_NUMBER partitions by the 6-col spot key,
    // orders by version_id DESC, and the outer query keeps rn=1. Ranked by
    // density_score DESC behind the hard CELL_LIMIT.
    sql =
      `SELECT ${selectCols} FROM (` +
        `SELECT *, ROW_NUMBER() OVER (` +
          `PARTITION BY server_id, zone_no, mob_id, cell_x, cell_z, channel ` +
          `ORDER BY version_id DESC` +
        `) AS rn ` +
        `FROM mob_spawn_cell_versions WHERE ${whereSql}` +
      `) ranked WHERE rn = 1 ` +
      `ORDER BY density_score DESC LIMIT ${CELL_LIMIT}`;
    binds = whereBinds;
  } else {
    // Exact version bucket — straight per-cell read of that version.
    sql =
      `SELECT ${selectCols} FROM mob_spawn_cell_versions WHERE ${whereSql} ` +
      `ORDER BY density_score DESC LIMIT ${CELL_LIMIT}`;
    binds = whereBinds;
  }

  const result = await db.raw(sql, binds);
  // mysql2 returns [rows, fields]; normalize to the rows array.
  const rows = Array.isArray(result) ? result[0] : (result.rows || result);

  return res.json({
    mode: 'version',
    version: version.kind === 'exact' ? version.version : version.kind,
    mob_id: mobId ?? null,
    data: rows.map(r => ({
      ...r,
      version_id:    String(r.version_id),
      reliability:   Number(r.reliability),
      typical_group: Number(r.typical_group),
      density_score: Number(r.density_score),
    })),
  });
}

// ── GET /servers ─────────────────────────────────────────────────────────────
// Visible servers only, with mob + cell counts. Hidden/unconfirmed servers
// (visible=false) never surface publicly [E4].
router.get('/servers', async (req, res) => {
  const servers = await db('game_servers')
    .where('visible', true)
    // name (034) is the admin label the client renders; keep ip/variant/port as
    // trivial fallbacks so an unnamed legacy row can still be labelled.
    .select('id', 'name', 'ip', 'variant', 'port', 'display_name', 'first_seen', 'last_seen')
    .orderBy('last_seen', 'desc')
    .limit(200);

  if (servers.length) {
    const ids = servers.map(s => s.id);
    const [mobCounts, cellCounts] = await Promise.all([
      db('mob_catalog').whereIn('server_id', ids)
        .groupBy('server_id').select('server_id', db.raw('COUNT(*) as mob_count')),
      db('mob_spawn_cells').whereIn('server_id', ids)
        .groupBy('server_id').select('server_id', db.raw('COUNT(*) as cell_count')),
    ]);
    const mobMap  = Object.fromEntries(mobCounts.map(c => [c.server_id, Number(c.mob_count)]));
    const cellMap = Object.fromEntries(cellCounts.map(c => [c.server_id, Number(c.cell_count)]));
    for (const s of servers) {
      s.mob_count  = mobMap[s.id]  || 0;
      s.cell_count = cellMap[s.id] || 0;
    }
  }

  res.json({ data: servers });
});

// ── GET /:serverId/mobs?q= ───────────────────────────────────────────────────
// Catalog search, ORDER BY sightings DESC, LIMIT. Feeds the mob picker.
router.get('/:serverId/mobs', async (req, res) => {
  const serverId = intParam(req.params.serverId);
  if (serverId == null) return res.status(400).json({ error: 'Bad serverId' });
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  let query = db('mob_catalog')
    .where('server_id', serverId)
    .select('mob_id', 'name', 'level_min', 'level_max', 'maxhp_min', 'maxhp_max', 'sightings_total', 'last_seen');
  if (q) {
    query = query.where(function () {
      this.where('name', 'like', `%${q}%`);
      const asId = intParam(q);
      if (asId != null) this.orWhere('mob_id', asId);
    });
  }
  const rows = await query
    .orderBy('sightings_total', 'desc')
    .limit(MOB_LIMIT);

  res.json({ data: rows });
});

// ── GET /:serverId/channels ──────────────────────────────────────────────────
// Distinct channels seen for a server — populates the ignore-filter UI.
router.get('/:serverId/channels', async (req, res) => {
  const serverId = intParam(req.params.serverId);
  if (serverId == null) return res.status(400).json({ error: 'Bad serverId' });

  const rows = await db('mob_spawn_cells')
    .where('server_id', serverId)
    .distinct('channel')
    .orderBy('channel', 'asc')
    .limit(256);

  res.json({ data: rows.map(r => r.channel) });
});

// ── GET /:serverId/names ─────────────────────────────────────────────────────
// Reference ZONE + MONSTER name lists for a server (035), served as id→name
// maps so the client MonsterMap can label the zone picker + mob labels by the
// real in-game name. Session-authed + visible-scoped (mirrors the other
// session-scoped reads). Empty maps when the bot has not exported names yet.
router.get('/:serverId/names', async (req, res) => {
  const serverId = intParam(req.params.serverId);
  if (serverId == null) return res.status(400).json({ error: 'Bad serverId' });
  if (!(await callerMaySeeServer(req, serverId))) {
    return res.status(403).json({ error: 'Server not visible' });
  }

  const [zoneRows, mobRows] = await Promise.all([
    db('game_zones').where('server_id', serverId).select('zone_no', 'name'),
    db('mob_names').where('server_id', serverId).select('mob_id', 'name'),
  ]);

  const zones = {};
  for (const r of zoneRows) zones[r.zone_no] = r.name;
  const mobs = {};
  for (const r of mobRows) mobs[r.mob_id] = r.name;

  res.json({ zones, mobs });
});

// ── GET /:serverId/zones/:zoneNo/spawns ──────────────────────────────────────
// The main heat query. Params:
//   mob_id           — restrict to one mob (returns per-cell rows).
//   channel          — filter to `channel = N OR channel = 0` [FIX]. With
//                      NOT NULL DEFAULT 0 there are NO NULL rows, so the old
//                      `channel = N OR channel IS NULL` would EXCLUDE the
//                      agnostic/legacy channel-0 data — must be `= 0`.
//   ignore_channels  — comma list → `channel NOT IN (...)`.
// Without mob_id → collapsed density: SUM(hits) GROUP BY cell across mobs
// (the pre-channel response shape older clients expect). Every path gets a
// hard ORDER BY density_score DESC LIMIT [E2][E6].
router.get('/:serverId/zones/:zoneNo/spawns', async (req, res) => {
  const serverId = intParam(req.params.serverId);
  const zoneNo   = intParam(req.params.zoneNo);
  if (serverId == null || zoneNo == null) return res.status(400).json({ error: 'Bad serverId/zoneNo' });

  const mobId          = intParam(req.query.mob_id);
  const channel        = intParam(req.query.channel);
  const ignoreChannels = intList(req.query.ignore_channels);

  // Optional versioned-spots read (STEP 3). No param → { kind: 'all' } → the
  // EXACT legacy all-time path below (byte-compatible for existing callers).
  const version = parseVersionParam(req.query.version);
  if (version == null) return res.status(400).json({ error: 'Bad version' });

  // 034: the channel dimension is REMOVED — data is always channel 0. The
  // ?channel / ?ignore_channels query params are now INERT (accepted for
  // back-compat, never filtered on) so every read spans all channels.
  const applyChannelFilter = (_qb) => { /* no-op — channel collapsed to 0 */ };

  // ── Versioned read (?version=latest | <number>) ─────────────────────────────
  // Serves from mob_spawn_cell_versions instead of the all-time mob_spawn_cells.
  //   latest  → NEWEST revision per spot: window ROW_NUMBER() PARTITION BY the
  //             6-col spot key ORDER BY version_id DESC, keep rn=1. (MySQL 8 has
  //             no Postgres DISTINCT ON; this is the portable equivalent.)
  //   <number>→ that exact version bucket (WHERE version_id = ?).
  // Each row carries its version_id + last_seen_sec so the client derives age.
  // The default all-time path (kind:'all') falls through UNCHANGED below.
  if (version.kind !== 'all') {
    return handleVersionedSpawns({
      res, serverId, zoneNo, mobId, channel, ignoreChannels, version,
    });
  }

  if (mobId != null) {
    // Single-mob path — per-cell rows, hard LIMIT safety net [E6]. 034: roll up
    // by CELL (GROUP BY cell_x, cell_z) so any residual pre-fold per-channel
    // rows collapse to one row per cell; SUM the additive counters and recompute
    // reliability/typical_group/density_score from the sums.
    const q = db('mob_spawn_cells')
      .where({ server_id: serverId, zone_no: zoneNo, mob_id: mobId });
    applyChannelFilter(q);
    const rows = await q
      .select('cell_x', 'cell_z')
      .select(db.raw('SUM(`hits`) as hits'))
      .select(db.raw('SUM(`passes`) as passes'))
      .select(db.raw('SUM(`instance_sum`) as instance_sum'))
      .select(db.raw('AVG(y_avg) as y_avg'))
      .select(db.raw('MAX(last_seen_sec) as last_seen_sec'))
      .select(db.raw(`${REL_AGG}     as reliability`))
      .select(db.raw(`${GROUP_AGG}   as typical_group`))
      .select(db.raw(`${DENSITY_AGG} as density_score`))
      .groupBy('cell_x', 'cell_z')
      .orderByRaw(`${DENSITY_AGG} DESC`)
      .limit(CELL_LIMIT);
    return res.json({
      mode: 'mob', mob_id: mobId,
      data: rows.map(r => ({
        ...r,
        mob_id:        mobId,
        // channel is collapsed — echo 0 so older clients that read r.channel
        // still get a stable value.
        channel:       0,
        hits:          Number(r.hits),
        passes:        Number(r.passes),
        instance_sum:  Number(r.instance_sum),
        reliability:   Number(r.reliability),
        typical_group: Number(r.typical_group),
        density_score: Number(r.density_score),
      })),
    });
  }

  // No mob_id → collapsed density: aggregate per cell across mobs, ranked by
  // the summed density_score [E2]. Already grouped by cell only (no channel).
  const q = db('mob_spawn_cells')
    .where({ server_id: serverId, zone_no: zoneNo });
  applyChannelFilter(q);
  const rows = await q
    .select('cell_x', 'cell_z')
    .select(db.raw('SUM(`hits`) as total'))
    .select(db.raw('SUM(`passes`) as passes'))
    .select(db.raw('SUM(`instance_sum`) as instance_sum'))
    .select(db.raw('AVG(y_avg) as y_avg'))
    .select(db.raw(`${REL_AGG}     as reliability`))
    .select(db.raw(`${GROUP_AGG}   as typical_group`))
    .select(db.raw(`${DENSITY_AGG} as density_score`))
    .groupBy('cell_x', 'cell_z')
    .orderByRaw(`${DENSITY_AGG} DESC`)
    .limit(CELL_LIMIT);

  res.json({
    mode: 'density',
    data: rows.map(r => ({
      ...r,
      total:         Number(r.total),
      reliability:   Number(r.reliability),
      typical_group: Number(r.typical_group),
      density_score: Number(r.density_score),
    })),
  });
});

// ── GET /:serverId/mobs/:mobId/spawns ────────────────────────────────────────
// All zones where this mob spawns — the "where does X spawn" view. Bounded.
router.get('/:serverId/mobs/:mobId/spawns', async (req, res) => {
  const serverId = intParam(req.params.serverId);
  const mobId    = intParam(req.params.mobId);
  if (serverId == null || mobId == null) return res.status(400).json({ error: 'Bad serverId/mobId' });

  // 034: channel is INERT (accepted, never filtered) and the data is rolled up
  // by CELL (GROUP BY zone_no, cell_x, cell_z) so any residual per-channel rows
  // collapse to one row per cell; SUM the additive counters.
  const q = db('mob_spawn_cells')
    .where({ server_id: serverId, mob_id: mobId });
  const rows = (await q
    .select('zone_no', 'cell_x', 'cell_z')
    .select(db.raw('SUM(`hits`) as hits'))
    .select(db.raw('SUM(`passes`) as passes'))
    .select(db.raw('SUM(`instance_sum`) as instance_sum'))
    .select(db.raw('AVG(y_avg) as y_avg'))
    .select(db.raw('MAX(last_seen_sec) as last_seen_sec'))
    .select(db.raw(`${REL_AGG}     as reliability`))
    .select(db.raw(`${GROUP_AGG}   as typical_group`))
    .select(db.raw(`${DENSITY_AGG} as density_score`))
    .groupBy('zone_no', 'cell_x', 'cell_z')
    .orderByRaw(`${DENSITY_AGG} DESC`)
    .limit(CELL_LIMIT)).map(r => ({
      ...r,
      channel:       0,   // collapsed — stable echo for older clients
      hits:          Number(r.hits),
      passes:        Number(r.passes),
      instance_sum:  Number(r.instance_sum),
      reliability:   Number(r.reliability),
      typical_group: Number(r.typical_group),
      density_score: Number(r.density_score),
    }));

  // Group by zone for the caller's convenience.
  const byZone = {};
  for (const r of rows) {
    (byZone[r.zone_no] ||= []).push(r);
  }
  res.json({ mob_id: mobId, zones: byZone, total_cells: rows.length });
});

// ── GET /:serverId/zones/:zoneNo/clusters ────────────────────────────────────
// Connected-cell (8-neighbour) agglomeration into "packs" — the user's
// "where do monsters stand incl. in larger groups" query. Requires mob_id (a
// meaningful pack is per-mob). Cells above min_count (on `hits`) are grown into
// groups; groups are returned capped/LIMITed [E2] and ranked by density_score.
router.get('/:serverId/zones/:zoneNo/clusters', async (req, res) => {
  const serverId = intParam(req.params.serverId);
  const zoneNo   = intParam(req.params.zoneNo);
  if (serverId == null || zoneNo == null) return res.status(400).json({ error: 'Bad serverId/zoneNo' });

  const mobId    = intParam(req.query.mob_id);
  if (mobId == null) return res.status(400).json({ error: 'mob_id required for clusters' });
  const minCount = Math.max(1, intParam(req.query.min_count, 1));

  // 034: channel is INERT and cells roll up by CELL (GROUP BY cell_x, cell_z)
  // so any residual per-channel rows collapse to one cell before the flood-fill;
  // the min_count gate now applies to the SUMmed hits (HAVING).
  const cells = await db('mob_spawn_cells')
    .where({ server_id: serverId, zone_no: zoneNo, mob_id: mobId })
    .select('cell_x', 'cell_z')
    .select(db.raw('SUM(`hits`) as hits'))
    .select(db.raw('SUM(`passes`) as passes'))
    .select(db.raw('SUM(`instance_sum`) as instance_sum'))
    .select(db.raw('AVG(y_avg) as y_avg'))
    .groupBy('cell_x', 'cell_z')
    .havingRaw('SUM(`hits`) >= ?', [minCount])   // min_count gates on total hits
    .orderByRaw('SUM(`hits`) DESC')
    .limit(CLUSTER_CELL_SCAN);

  // SUM()/AVG() come back as strings from mysql2 — coerce to numbers before the
  // flood-fill (agglomerateCells does numeric arithmetic on these fields).
  const normCells = cells.map(c => ({
    cell_x:       c.cell_x,
    cell_z:       c.cell_z,
    hits:         Number(c.hits),
    passes:       Number(c.passes),
    instance_sum: Number(c.instance_sum),
    y_avg:        c.y_avg == null ? null : Number(c.y_avg),
  }));

  // 8-neighbour flood fill over the sparse cell set (shared helper).
  const clusters = agglomerateCells(normCells);

  // Densest packs first, capped.
  clusters.sort((a, b) => b.density_score - a.density_score);
  res.json({ mob_id: mobId, data: clusters.slice(0, CLUSTER_LIMIT) });
});

// ── GET /:serverId/zones/:zoneNo/bounds ──────────────────────────────────────
// Zone framing for the user map SVG. The zone_bounds table (migration 029) is
// populated by the super-admin upload POST /api/admin/world/servers/:id/zones/
// :zoneNo/bounds (the bot's map-export calib.json). Cells are 4 m: world =
// origin + cell*cell_size_m.
// Returns the single bounds row for (server, zone) or 404 when the bot has not
// yet reported bounds for that zone. Read-only, ADDITIVE.
router.get('/:serverId/zones/:zoneNo/bounds', async (req, res) => {
  const serverId = intParam(req.params.serverId);
  const zoneNo   = intParam(req.params.zoneNo);
  if (serverId == null || zoneNo == null) return res.status(400).json({ error: 'Bad serverId/zoneNo' });

  const row = await db('zone_bounds')
    .where({ server_id: serverId, zone_no: zoneNo })
    .select(
      'server_id', 'zone_no',
      'origin_x', 'origin_z',
      'world_min_x', 'world_min_z', 'world_max_x', 'world_max_z',
      'size_px', 'meters_per_pixel', 'cell_size_m',
    )
    .first();

  if (!row) return res.status(404).json({ error: 'No bounds for that zone' });
  res.json({ data: row });
});

// ── GET /:serverId/zones/:zoneNo/map ─────────────────────────────────────────
// Stream the uploaded background image for (server, zone). Session-authed (the
// whole /api/portal tree is force-authed) [E7]. Referenced by the user
// MonsterMap via <image href> (a non-scripting SVG context), but we HARDEN the
// direct-open path too: an SVG can carry <script>, so we set nosniff + a strict
// CSP + sandbox so an embedded script can't execute even if the URL is opened
// directly in a browser tab. 404 when no image row/file exists. Additive.
router.get('/:serverId/zones/:zoneNo/map', async (req, res) => {
  const serverId = intParam(req.params.serverId);
  const zoneNo   = intParam(req.params.zoneNo);
  if (serverId == null || zoneNo == null) return res.status(400).json({ error: 'Bad serverId/zoneNo' });

  const row = await db('zone_maps')
    .where({ server_id: serverId, zone_no: zoneNo })
    .select('format', 'file_name', 'content_type', 'byte_size')
    .first();
  if (!row) return res.status(404).json({ error: 'No background image for that zone' });

  const filePath = path.join(ZONE_MAP_DIR, row.file_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Image file missing' });

  const contentType = row.content_type || (row.format === 'png' ? 'image/png' : 'image/svg+xml');
  res.setHeader('Content-Type', contentType);
  // Never let a browser sniff this into an executable type.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Harden the direct-open path for SVG (can embed <script>): deny all
  // sub-resources + scripts, allow only inline styles, and sandbox the doc so
  // even an inline <script> cannot execute if the URL is opened directly.
  if (row.format === 'svg') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
  // Short cache — the admin can replace the image; don't pin a stale one for long.
  res.setHeader('Cache-Control', 'private, max-age=60');

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
  stream.pipe(res);
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE B — BULK USER-FACING MAP READS (B1)
// The user MonsterMap loads the WHOLE browse structure per server ONCE and
// caches it client-side, then toggles mobs from that cache with ZERO further
// requests. These three ADDITIVE reads replace the per-mob request fan-out
// (mobSpawns → zone derivation + per-mob zoneClusters/zoneSpawns) that tripped
// the rate limiter. All are session-authed + visible-scoped (callerMaySeeServer,
// NOT super-admin) and hard-LIMIT-capped. None touch the routes above.
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /:serverId/zones/:zoneNo/spawns-all?version=latest|all|<id> ───────────
// ALL mobs' cells for ONE zone in ONE query — the bulk analogue of the single-
// mob /zones/:z/spawns path, with the mob_id FILTER dropped and mob_id KEPT in
// the SELECT + GROUP BY (so the client can bucket cells per mob and toggle them
// from cache). Same versioned-read model as /spawns:
//   version=all|<none> → all-time mob_spawn_cells, SUM the additive counters and
//                         recompute reliability/typical_group/density_score.
//   version=latest|<id>→ mob_spawn_cell_versions (newest-per-spot window / one
//                         exact bucket), mob_id kept in SELECT (no per-mob filter).
// Ranked density_score DESC behind the hard CELL_LIMIT (5000) — this is a HARD
// cap; `truncated` tells the client the zone overflowed. NEVER whole-server: the
// (server,zone) predicate is mandatory. Every cell also carries world x/z/y (from
// zone_bounds when framed) so the client renders per-cell heat nodes directly.
router.get('/:serverId/zones/:zoneNo/spawns-all', async (req, res) => {
  const serverId = intParam(req.params.serverId);
  const zoneNo   = intParam(req.params.zoneNo);
  if (serverId == null || zoneNo == null) return res.status(400).json({ error: 'Bad serverId/zoneNo' });
  if (!(await callerMaySeeServer(req, serverId))) {
    return res.status(403).json({ error: 'Server not visible' });
  }

  const version = parseVersionParam(req.query.version);
  if (version == null) return res.status(400).json({ error: 'Bad version' });

  // World-coord frame (optional). When a zone_bounds row exists, cell centroids
  // map to world metres: world = origin + cell*cell_size_m. Y stays the cell's
  // observed y_avg. Without a frame, x/z fall back to the raw cell centroid.
  const bounds = await db('zone_bounds')
    .where({ server_id: serverId, zone_no: zoneNo })
    .select('origin_x', 'origin_z', 'cell_size_m')
    .first();
  const cellSize = bounds && bounds.cell_size_m != null ? Number(bounds.cell_size_m) : null;
  const originX  = bounds ? Number(bounds.origin_x) : null;
  const originZ  = bounds ? Number(bounds.origin_z) : null;
  const worldX = (cx) => (cellSize != null ? originX + cx * cellSize : cx);
  const worldZ = (cz) => (cellSize != null ? originZ + cz * cellSize : cz);

  let rows;
  let resolved;

  if (version.kind === 'all') {
    // All-time bulk read: same per-cell rollup as the single-mob path but KEEP
    // mob_id in the SELECT + GROUP BY so every mob's cells come back at once.
    rows = await db('mob_spawn_cells')
      .where({ server_id: serverId, zone_no: zoneNo })
      .select('mob_id', 'cell_x', 'cell_z')
      .select(db.raw('SUM(`hits`) as hits'))
      .select(db.raw('SUM(`passes`) as passes'))
      .select(db.raw('SUM(`instance_sum`) as instance_sum'))
      .select(db.raw('AVG(y_avg) as y_avg'))
      .select(db.raw('MAX(last_seen_sec) as last_seen_sec'))
      .select(db.raw(`${REL_AGG}     as reliability`))
      .select(db.raw(`${GROUP_AGG}   as typical_group`))
      .select(db.raw(`${DENSITY_AGG} as density_score`))
      .groupBy('mob_id', 'cell_x', 'cell_z')
      .orderByRaw(`${DENSITY_AGG} DESC`)
      .limit(CELL_LIMIT);
    resolved = 'all';
  } else {
    // Versioned bulk read from mob_spawn_cell_versions. mob_id is KEPT (no per-mob
    // filter). 'latest' = newest revision per spot (ROW_NUMBER window over the
    // 6-col spot key); '<id>' = one exact version bucket. Ranked density_score
    // DESC behind CELL_LIMIT.
    const baseWhere = 'server_id = ? AND zone_no = ?';
    const baseBinds = [serverId, zoneNo];
    const selectCols =
      'mob_id, cell_x, cell_z, channel, version_id, y_avg, hits, passes, instance_sum, last_seen_sec, ' +
      `${REL_EXPR} as reliability, ${GROUP_EXPR} as typical_group, ${DENSITY_EXPR} as density_score`;

    let sql;
    let binds;
    if (version.kind === 'latest') {
      sql =
        `SELECT ${selectCols} FROM (` +
          `SELECT *, ROW_NUMBER() OVER (` +
            `PARTITION BY server_id, zone_no, mob_id, cell_x, cell_z, channel ` +
            `ORDER BY version_id DESC` +
          `) AS rn ` +
          `FROM mob_spawn_cell_versions WHERE ${baseWhere}` +
        `) ranked WHERE rn = 1 ` +
        `ORDER BY density_score DESC LIMIT ${CELL_LIMIT}`;
      binds = baseBinds;
    } else {
      // exact bucket
      sql =
        `SELECT ${selectCols} FROM mob_spawn_cell_versions ` +
        `WHERE ${baseWhere} AND version_id = ? ` +
        `ORDER BY density_score DESC LIMIT ${CELL_LIMIT}`;
      binds = [...baseBinds, version.version];
    }
    const result = await db.raw(sql, binds);
    rows = Array.isArray(result) ? result[0] : (result.rows || result);
    resolved = version.kind === 'exact' ? version.version : version.kind;
  }

  return res.json({
    version:   resolved,
    truncated: rows.length >= CELL_LIMIT,
    cells: rows.map(r => {
      const cellX = r.cell_x;
      const cellZ = r.cell_z;
      const y = r.y_avg == null ? null : Number(r.y_avg);
      return {
        mob_id:        r.mob_id,
        cell_x:        cellX,
        cell_z:        cellZ,
        x:             worldX(cellX),
        z:             worldZ(cellZ),
        y,
        hits:          Number(r.hits),
        passes:        Number(r.passes),
        instance_sum:  Number(r.instance_sum),
        density_score: Number(r.density_score),
        reliability:   Number(r.reliability),
        typical_group: Number(r.typical_group),
        last_seen_sec: r.last_seen_sec == null ? null : Number(r.last_seen_sec),
      };
    }),
  });
});

// ── GET /:serverId/zone-index ─────────────────────────────────────────────────
// The WHOLE-server browse index in ONE query set — this REPLACES the client's
// per-mob zone derivation (mobSpawns) AND folds in /names labelling:
//   mobs      — the catalog (mob_names ∪ mob_catalog, exactly like the admin
//               Phase A union; name = mob_names ?? mob_catalog.name), each with
//               the DISTINCT zone_no list it appears in.
//   zoneNames — { "<zone_no>": "<name>" } from game_zones.
// The (mob_id, zone_no) pairs come from a DISTINCT rollup over mob_spawn_cells
// (built into zones[] arrays in JS — NOT via GROUP_CONCAT). A mob with no spawn
// cells simply gets an empty zones[]. Session-authed + visible-scoped.
router.get('/:serverId/zone-index', async (req, res) => {
  const serverId = intParam(req.params.serverId);
  if (serverId == null) return res.status(400).json({ error: 'Bad serverId' });
  if (!(await callerMaySeeServer(req, serverId))) {
    return res.status(403).json({ error: 'Server not visible' });
  }

  const [mobNameRows, mobCatalogRows, mobZoneRows, zoneRows] = await Promise.all([
    // Curated names (prefer this name).
    db('mob_names').where('server_id', serverId).select('mob_id', 'name'),
    // Observed catalog rows (name fallback + metrics for label/sort).
    db('mob_catalog').where('server_id', serverId)
      .select('mob_id', 'name', 'level_min', 'level_max', 'sightings_total'),
    // DISTINCT (mob_id, zone_no) rollup — the zones[] source. Built into arrays
    // in JS below (NO GROUP_CONCAT), ordered so zones[] come out ascending.
    db('mob_spawn_cells').where('server_id', serverId)
      .distinct('mob_id', 'zone_no')
      .orderBy('mob_id', 'asc').orderBy('zone_no', 'asc'),
    // Zone label map.
    db('game_zones').where('server_id', serverId).select('zone_no', 'name'),
  ]);

  // (mob_id, zone_no) DISTINCT pairs → per-mob ascending zones[] arrays.
  const zonesByMob = new Map();
  for (const r of mobZoneRows) {
    let arr = zonesByMob.get(r.mob_id);
    if (!arr) { arr = []; zonesByMob.set(r.mob_id, arr); }
    arr.push(r.zone_no);
  }

  // MONSTER UNION (mirror admin Phase A): union the curated + observed id-sets so
  // a seen-but-unnamed mob still surfaces; name prefers mob_names, falls back to
  // mob_catalog.name, else null.
  const mobNameById    = new Map(mobNameRows.map(r => [r.mob_id, r.name]));
  const mobCatalogById = new Map(mobCatalogRows.map(r => [r.mob_id, r]));
  const mobIdSet = new Set();
  for (const r of mobNameRows)    mobIdSet.add(r.mob_id);
  for (const r of mobCatalogRows) mobIdSet.add(r.mob_id);
  for (const mobId of zonesByMob.keys()) mobIdSet.add(mobId);

  const mobs = [...mobIdSet].sort((a, b) => a - b).map((mob_id) => {
    const cat  = mobCatalogById.get(mob_id) || null;
    const name = mobNameById.has(mob_id) ? mobNameById.get(mob_id) : (cat && cat.name != null ? cat.name : null);
    return {
      mob_id,
      name,
      level_min:       cat ? cat.level_min : null,
      level_max:       cat ? cat.level_max : null,
      sightings_total: cat && cat.sightings_total != null ? Number(cat.sightings_total) : null,
      zones:           zonesByMob.get(mob_id) || [],
    };
  });

  const zoneNames = {};
  for (const r of zoneRows) zoneNames[r.zone_no] = r.name;

  res.json({ mobs, zoneNames });
});

// ── GET /:serverId/versions?zone_no=<n> ───────────────────────────────────────
// A USER-SAFE projection of spawn_version_meta for the server (optionally to one
// zone) — powers the FINE version/date picker. Newest-first. is_current =
// version_id == MAX(version_id) for that (server[,zone]), via the SAME per-zone
// MAX subquery as /sessions. ABSOLUTELY NO user_id/session_id/recorder fields —
// this is NOT the admin /sessions route. Session-authed + visible-scoped.
router.get('/:serverId/versions', async (req, res) => {
  const serverId = intParam(req.params.serverId);
  if (serverId == null) return res.status(400).json({ error: 'Bad serverId' });
  if (!(await callerMaySeeServer(req, serverId))) {
    return res.status(403).json({ error: 'Server not visible' });
  }

  const zoneNo = intParam(req.query.zone_no);

  // Meta rows joined to a per-zone MAX(version_id) so is_current is a single
  // subquery (no ROW_NUMBER window). Newest-first, LIMIT-capped (SESSIONS_LIMIT).
  const metaWhere = ['m.server_id = ?'];
  const metaBinds = [serverId];
  if (zoneNo != null) { metaWhere.push('m.zone_no = ?'); metaBinds.push(zoneNo); }

  const sql =
    `SELECT ` +
      `m.zone_no, m.version_id, m.ver_start_sec, m.ver_end_sec, m.run_count, ` +
      `mx.max_version ` +
    `FROM spawn_version_meta m ` +
    `JOIN ( ` +
      `SELECT server_id, zone_no, MAX(version_id) AS max_version ` +
      `FROM spawn_version_meta WHERE server_id = ? GROUP BY server_id, zone_no ` +
    `) mx ON mx.server_id = m.server_id AND mx.zone_no = m.zone_no ` +
    `WHERE ${metaWhere.join(' AND ')} ` +
    `ORDER BY m.version_id DESC ` +
    `LIMIT ${SESSIONS_LIMIT}`;

  const binds = [serverId, ...metaBinds];
  const result = await db.raw(sql, binds);
  const rows = Array.isArray(result) ? result[0] : (result.rows || result);

  res.json({
    server_id: serverId,
    zone_no:   zoneNo ?? null,
    data: rows.map(r => ({
      version_id:    String(r.version_id),
      zone_no:       r.zone_no,
      ver_start_sec: Number(r.ver_start_sec),
      ver_end_sec:   Number(r.ver_end_sec),
      run_count:     Number(r.run_count),
      // is_current iff this version == the newest version for its (server,zone).
      is_current:    String(r.version_id) === String(r.max_version),
    })),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SESSION-SCOPED READS (recording status, my tokens, scan sessions, coverage,
// version diff). All ADDITIVE, session-authed, visible-scoped for non-admins,
// LIMIT-capped. None touch the existing routes/responses/auth/CSRF above.
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /my-ingest-tokens ────────────────────────────────────────────────────
// The caller's OWN ingest tokens (F1: user only VIEWS — no self-mint here; that
// stays super-admin at /api/admin/world/ingest-token). Returns ONLY safe fields
// — NEVER license_key or any token secret. status/remaining_seconds are derived
// on read so the UI can render active/expired/revoked without re-parsing dates.
router.get('/my-ingest-tokens', async (req, res) => {
  const userId = sessionUserId(req);
  if (userId == null) return res.status(401).json({ error: 'Not authenticated' });

  const now = Math.floor(Date.now() / 1000);
  const rows = await db('issued_ingest_tokens')
    .where('user_id', userId)
    // Explicit column list — deliberately EXCLUDES license_key so a secret can
    // never leak through this user-facing read.
    .select('jti', 'scope', 'revoked', 'expires_at', 'created_at')
    .orderBy('created_at', 'desc')
    .limit(200);

  res.json({
    data: rows.map(r => {
      const revoked = !!r.revoked;
      const expiresAt = Number(r.expires_at);
      const expired = expiresAt <= now;
      const status = revoked ? 'revoked' : (expired ? 'expired' : 'active');
      return {
        jti:               r.jti,
        scope:             r.scope,
        created_at:        Number(r.created_at),
        expires_at:        expiresAt,
        revoked,
        status,
        remaining_seconds: Math.max(0, expiresAt - now),
      };
    }),
  });
});

// ── GET /my-recording-status ─────────────────────────────────────────────────
// Whether the caller's spawn_tracking is enabled — computed FRESH from the DB
// (never the session cache, which can be stale after an admin flips a flag).
// Mirrors bot.world.js loadUserAndGate EXACTLY so a super-admin reads as enabled
// even when their stored feature_flags is null/synthetic.
router.get('/my-recording-status', async (req, res) => {
  const userId = sessionUserId(req);
  if (userId == null) return res.status(401).json({ error: 'Not authenticated' });

  const user = await db('users').where('id', userId)
    .select('id', 'role', 'feature_flags').first();

  // loadUserAndGate mirror: super_admin bypass OR truthy feature_flags.spawn_tracking.
  let enabled = false;
  if (user) {
    if (user.role === 'super_admin') {
      enabled = true;
    } else {
      let flags = {};
      if (user.feature_flags) {
        try { flags = JSON.parse(user.feature_flags); } catch { flags = {}; }
      }
      enabled = !!flags.spawn_tracking;
    }
  }

  res.json({ spawn_tracking: enabled });
});

// ── GET /:serverId/sessions?zone_no=&limit= ──────────────────────────────────
// Scan sessions (spawn_version_meta rows) for a server, newest window first.
// Visible-server scoped for non-admins. For each meta row a LEFT JOIN over a
// GROUP BY version_id subquery of mob_spawn_cell_versions supplies:
//   renewed_spots = COUNT(DISTINCT mob_id,cell_x,cell_z)   — spots this run renewed
//   total_hits    = SUM(hits)
//   distinct_mobs = COUNT(DISTINCT mob_id)
// is_current (F5 CURRENT chip) = version_id == MAX(version_id) for that
// (server_id,zone_no), computed via a SINGLE per-zone MAX subquery (NOT a
// per-spot ROW_NUMBER window). Recorder name (recorded_by) is surfaced ONLY to
// admins, read via a guarded side query so a missing user_id column can never
// 500 this route. version_id returned as a STRING (bigint-safe).
router.get('/:serverId/sessions', async (req, res) => {
  // RECORDING UI is ADMIN-ONLY now (moved to the admin area). Non-super-admins
  // are 403'd — the map/servers/spawns/clusters/bounds/names reads stay
  // user-facing, only the recording sessions/coverage/diff/detail views are gated.
  if (!reqIsSuperAdmin(req)) return res.status(403).json({ error: 'Super-admin access required' });

  const serverId = intParam(req.params.serverId);
  if (serverId == null) return res.status(400).json({ error: 'Bad serverId' });
  if (!(await callerMaySeeServer(req, serverId))) {
    return res.status(403).json({ error: 'Server not visible' });
  }

  const zoneNo = intParam(req.query.zone_no);
  const limit  = Math.min(SESSIONS_LIMIT, Math.max(1, intParam(req.query.limit, SESSIONS_LIMIT)));

  // Base meta rows, newest window first. zone_no optional narrows to one zone.
  const metaWhere = ['m.server_id = ?'];
  const metaBinds = [serverId];
  if (zoneNo != null) { metaWhere.push('m.zone_no = ?'); metaBinds.push(zoneNo); }

  // Per-version rollup from the versioned cells (GROUP BY version_id, scoped to
  // this server so the join stays cheap).
  // Per-zone MAX(version_id) → the is_current source (single subquery, no window).
  const sql =
    `SELECT ` +
      `m.zone_no, m.version_id, m.ver_start_sec, m.ver_end_sec, m.run_count, m.updated_at, ` +
      `mx.max_version, ` +
      `agg.renewed_spots, agg.total_hits, agg.distinct_mobs ` +
    `FROM spawn_version_meta m ` +
    `JOIN ( ` +
      `SELECT server_id, zone_no, MAX(version_id) AS max_version ` +
      `FROM spawn_version_meta WHERE server_id = ? GROUP BY server_id, zone_no ` +
    `) mx ON mx.server_id = m.server_id AND mx.zone_no = m.zone_no ` +
    `LEFT JOIN ( ` +
      `SELECT version_id, ` +
        `COUNT(DISTINCT mob_id, cell_x, cell_z) AS renewed_spots, ` +
        `SUM(hits) AS total_hits, ` +
        `COUNT(DISTINCT mob_id) AS distinct_mobs ` +
      `FROM mob_spawn_cell_versions WHERE server_id = ? GROUP BY version_id ` +
    `) agg ON agg.version_id = m.version_id ` +
    `WHERE ${metaWhere.join(' AND ')} ` +
    `ORDER BY m.ver_end_sec DESC ` +
    `LIMIT ${limit}`;

  const binds = [serverId, serverId, ...metaBinds];
  const result = await db.raw(sql, binds);
  const rows = Array.isArray(result) ? result[0] : (result.rows || result);

  // Recorder names — admins only. Read via a guarded side query keyed on the
  // returned version_ids so a not-yet-migrated spawn_version_meta.user_id column
  // degrades to null recorders instead of 500ing the whole route.
  let recorderByKey = null;
  if (reqIsAdmin(req) && rows.length) {
    try {
      const recRows = await db('spawn_version_meta as m')
        .where('m.server_id', serverId)
        .modify((qb) => { if (zoneNo != null) qb.where('m.zone_no', zoneNo); })
        .leftJoin('users as u', 'm.user_id', 'u.id')
        .select('m.zone_no', 'm.version_id', 'u.name as recorded_by', 'm.user_id as recorder_id')
        .orderBy('m.ver_end_sec', 'desc')
        .limit(limit);
      recorderByKey = new Map();
      for (const rr of recRows) {
        recorderByKey.set(`${rr.zone_no}|${String(rr.version_id)}`, {
          recorded_by:  rr.recorded_by ?? null,
          recorder_id:  rr.recorder_id ?? null,
        });
      }
    } catch {
      // user_id column absent (not yet migrated) → omit recorder, don't fail.
      recorderByKey = null;
    }
  }

  res.json({
    server_id: serverId,
    data: rows.map(r => {
      const out = {
        zone_no:       r.zone_no,
        version_id:    String(r.version_id),
        ver_start_sec: Number(r.ver_start_sec),
        ver_end_sec:   Number(r.ver_end_sec),
        run_count:     Number(r.run_count),
        updated_at:    Number(r.updated_at),
        renewed_spots: r.renewed_spots == null ? 0 : Number(r.renewed_spots),
        total_hits:    r.total_hits    == null ? 0 : Number(r.total_hits),
        distinct_mobs: r.distinct_mobs == null ? 0 : Number(r.distinct_mobs),
        // F5: CURRENT iff this version == the newest version for its (server,zone).
        is_current:    String(r.version_id) === String(r.max_version),
      };
      if (recorderByKey) {
        const rec = recorderByKey.get(`${r.zone_no}|${String(r.version_id)}`);
        out.recorded_by = rec ? rec.recorded_by : null;
      }
      return out;
    }),
  });
});

// ── GET /:serverId/coverage ──────────────────────────────────────────────────
// Per-zone freshness/coverage summary — one grouped query over
// spawn_version_meta joined to a per-zone renewed-spots rollup. Drives a
// coverage heatmap: last_scanned (recency), version_count (how many sessions),
// total_renewed_spots (breadth). zone_bounds presence is folded in cheaply so
// the UI can mark zones lacking a world-coord frame. Visible-server scoped.
router.get('/:serverId/coverage', async (req, res) => {
  // RECORDING UI is ADMIN-ONLY now — non-super-admins are 403'd (see /sessions).
  if (!reqIsSuperAdmin(req)) return res.status(403).json({ error: 'Super-admin access required' });

  const serverId = intParam(req.params.serverId);
  if (serverId == null) return res.status(400).json({ error: 'Bad serverId' });
  if (!(await callerMaySeeServer(req, serverId))) {
    return res.status(403).json({ error: 'Server not visible' });
  }

  // Grouped over meta (recency + version_count) LEFT JOINed to a per-zone
  // renewed-spot rollup and to zone_bounds for the has_bounds flag.
  const sql =
    `SELECT ` +
      `m.zone_no, ` +
      `MAX(m.ver_end_sec) AS last_scanned, ` +
      `COUNT(*) AS version_count, ` +
      `COALESCE(cov.total_renewed_spots, 0) AS total_renewed_spots, ` +
      `CASE WHEN zb.zone_no IS NULL THEN 0 ELSE 1 END AS has_bounds ` +
    `FROM spawn_version_meta m ` +
    `LEFT JOIN ( ` +
      `SELECT zone_no, COUNT(DISTINCT mob_id, cell_x, cell_z) AS total_renewed_spots ` +
      `FROM mob_spawn_cell_versions WHERE server_id = ? GROUP BY zone_no ` +
    `) cov ON cov.zone_no = m.zone_no ` +
    `LEFT JOIN zone_bounds zb ON zb.server_id = m.server_id AND zb.zone_no = m.zone_no ` +
    `WHERE m.server_id = ? ` +
    `GROUP BY m.zone_no, cov.total_renewed_spots, has_bounds ` +
    `ORDER BY last_scanned DESC ` +
    `LIMIT ${COVERAGE_ZONE_LIMIT}`;

  const result = await db.raw(sql, [serverId, serverId]);
  const rows = Array.isArray(result) ? result[0] : (result.rows || result);

  res.json({
    server_id: serverId,
    data: rows.map(r => ({
      zone_no:             r.zone_no,
      last_scanned:        Number(r.last_scanned),
      version_count:       Number(r.version_count),
      total_renewed_spots: Number(r.total_renewed_spots),
      has_bounds:          !!Number(r.has_bounds),
    })),
  });
});

// ── GET /:serverId/zones/:zoneNo/diff?a=<version_id>&b=<version_id>&channel= ──
// Compare two scan sessions' cells for a zone. FULL-OUTER-JOIN on the spot key
// (mob_id,cell_x,cell_z,channel) is emulated in MySQL via a UNION of a LEFT and
// a RIGHT (anti-)join. Each matched/unmatched spot is classified:
//   added          — present only in b
//   removed        — present only in a
//   group_changed  — present in both but typicalGroup (instance_sum/hits) differs
//   same           — present in both, group unchanged
// ("moved" is reported as a bucket for API completeness; with a fixed spot key
// a move surfaces as an add+remove pair, so its count stays 0 here.)
// Both a & b are REQUIRED (400 else) and validated as digit strings (bigint-safe
// as string binds). Visible-server scoped; the returned spot list is capped.
router.get('/:serverId/zones/:zoneNo/diff', async (req, res) => {
  // RECORDING UI is ADMIN-ONLY now — non-super-admins are 403'd (see /sessions).
  if (!reqIsSuperAdmin(req)) return res.status(403).json({ error: 'Super-admin access required' });

  const serverId = intParam(req.params.serverId);
  const zoneNo   = intParam(req.params.zoneNo);
  if (serverId == null || zoneNo == null) return res.status(400).json({ error: 'Bad serverId/zoneNo' });
  if (!(await callerMaySeeServer(req, serverId))) {
    return res.status(403).json({ error: 'Server not visible' });
  }

  // Both required, digits only (carried as STRING binds for a BIGINT column).
  const aRaw = typeof req.query.a === 'string' ? req.query.a.trim() : '';
  const bRaw = typeof req.query.b === 'string' ? req.query.b.trim() : '';
  if (!aRaw || !bRaw) return res.status(400).json({ error: 'Both a and b version_ids required' });
  if (!/^\d+$/.test(aRaw) || !/^\d+$/.test(bRaw)) {
    return res.status(400).json({ error: 'a and b must be numeric version_ids' });
  }

  const channel = intParam(req.query.channel);
  // Channel filter applied identically to BOTH version sub-selects.
  const chSql   = channel != null ? ' AND (channel = ? OR channel = 0)' : '';
  const chBinds = channel != null ? [channel] : [];

  // A per-version, per-spot aggregate (collapse channel-0 dup rows defensively)
  // exposing hits + instance_sum so typicalGroup = instance_sum/GREATEST(hits,1).
  const verSel = (alias) =>
    `SELECT mob_id, cell_x, cell_z, channel, ` +
      `SUM(hits) AS hits, SUM(instance_sum) AS instance_sum ` +
    `FROM mob_spawn_cell_versions ` +
    `WHERE server_id = ? AND zone_no = ? AND version_id = ?${chSql} ` +
    `GROUP BY mob_id, cell_x, cell_z, channel`;

  // FULL OUTER JOIN emulation: (a LEFT JOIN b) UNION (b LEFT JOIN a WHERE a IS NULL).
  const spotKey = 'a.mob_id <=> b.mob_id AND a.cell_x <=> b.cell_x AND a.cell_z <=> b.cell_z AND a.channel <=> b.channel';
  const sql =
    `SELECT ` +
      `COALESCE(a.mob_id, b.mob_id) AS mob_id, ` +
      `COALESCE(a.cell_x, b.cell_x) AS cell_x, ` +
      `COALESCE(a.cell_z, b.cell_z) AS cell_z, ` +
      `COALESCE(a.channel, b.channel) AS channel, ` +
      `a.hits AS a_hits, a.instance_sum AS a_instance_sum, ` +
      `b.hits AS b_hits, b.instance_sum AS b_instance_sum ` +
    `FROM (${verSel('a')}) a LEFT JOIN (${verSel('b')}) b ON ${spotKey} ` +
    `UNION ` +
    `SELECT ` +
      `COALESCE(a.mob_id, b.mob_id), COALESCE(a.cell_x, b.cell_x), ` +
      `COALESCE(a.cell_z, b.cell_z), COALESCE(a.channel, b.channel), ` +
      `a.hits, a.instance_sum, b.hits, b.instance_sum ` +
    `FROM (${verSel('b')}) b LEFT JOIN (${verSel('a')}) a ON ${spotKey} ` +
    `WHERE a.mob_id IS NULL ` +
    `LIMIT ${DIFF_LIST_LIMIT}`;

  // Bind order follows the four verSel occurrences (a,b) then (b,a).
  const binds = [
    serverId, zoneNo, aRaw, ...chBinds,   // first a
    serverId, zoneNo, bRaw, ...chBinds,   // first b
    serverId, zoneNo, bRaw, ...chBinds,   // second b
    serverId, zoneNo, aRaw, ...chBinds,   // second a
  ];
  const result = await db.raw(sql, binds);
  const rows = Array.isArray(result) ? result[0] : (result.rows || result);

  const typGroup = (hits, inst) => (inst == null ? 0 : Number(inst)) / Math.max(1, hits == null ? 0 : Number(hits));
  const counts = { added: 0, removed: 0, moved: 0, group_changed: 0, same: 0 };
  const list = [];
  for (const r of rows) {
    const inA = r.a_hits != null || r.a_instance_sum != null;
    const inB = r.b_hits != null || r.b_instance_sum != null;
    let status;
    if (inA && !inB)      status = 'removed';
    else if (!inA && inB) status = 'added';
    else {
      const ga = typGroup(r.a_hits, r.a_instance_sum);
      const gb = typGroup(r.b_hits, r.b_instance_sum);
      status = Math.abs(ga - gb) > 1e-9 ? 'group_changed' : 'same';
    }
    counts[status] += 1;
    list.push({
      mob_id:  r.mob_id,
      cell_x:  r.cell_x,
      cell_z:  r.cell_z,
      channel: r.channel,
      status,
      a_hits:  r.a_hits == null ? null : Number(r.a_hits),
      b_hits:  r.b_hits == null ? null : Number(r.b_hits),
    });
  }

  res.json({
    server_id: serverId,
    zone_no:   zoneNo,
    a: aRaw,
    b: bRaw,
    channel:   channel ?? null,
    counts,
    truncated: rows.length >= DIFF_LIST_LIMIT,
    data:      list,
  });
});

// ── GET /:serverId/zones/:zoneNo/sessions/:versionId/detail ──────────────────
// WHAT one scan session (server,zone,version) RENEWED, grouped by mob, plus a
// per-spot change status vs the PREVIOUS session of that zone. Additive,
// session-authed, visible-scoped, capped. Nothing above is touched.
//
// (1) RENEWED SPOTS — take mob_spawn_cell_versions WHERE server_id,zone_no,
//     version_id = params, cluster its cells per mob via the SHARED
//     agglomerateCells() 8-neighbour helper (same spot geometry as /clusters),
//     then group the resulting spots (response key `mobs`) under
//     { mob_id, mob_name, spot_count, spots }.
//     center_x/center_z are world coords (origin + cell*cell_size_m) when a
//     zone_bounds row exists, else the raw cell centroid.
//
// (2) CHANGE STATUS — prev_version_id = MAX(version_id) < :versionId for
//     (server,zone) (null if none). Each renewed CELL is classified vs the same
//     spot key (mob_id,cell_x,cell_z,channel) in prev's cells:
//       'new'           — spot key absent in prev
//       'group_changed' — present, but typicalGroup (instance_sum/GREATEST(hits,1)) differs
//       'same'          — present, group unchanged
//     A SPOT rolls up to a dominant status: 'new' if any/most member cells new,
//     else 'group_changed' if any member group-changed, else 'same'.
//     summary:{added,removed,group_changed,same} uses the SAME cell/spot-key diff
//     semantics as /diff (prev = a, this = b): added = in this only, removed = in
//     prev only, group_changed = both but group differs, same = both unchanged.
router.get('/:serverId/zones/:zoneNo/sessions/:versionId/detail', async (req, res) => {
  // RECORDING UI is ADMIN-ONLY now — non-super-admins are 403'd (see /sessions).
  if (!reqIsSuperAdmin(req)) return res.status(403).json({ error: 'Super-admin access required' });

  const serverId = intParam(req.params.serverId);
  const zoneNo   = intParam(req.params.zoneNo);
  if (serverId == null || zoneNo == null) return res.status(400).json({ error: 'Bad serverId/zoneNo' });
  if (!(await callerMaySeeServer(req, serverId))) {
    return res.status(403).json({ error: 'Server not visible' });
  }

  // versionId digits only, carried as a STRING bind (bigint-safe for a BIGINT column).
  const vRaw = typeof req.params.versionId === 'string' ? req.params.versionId.trim() : '';
  if (!/^\d+$/.test(vRaw)) return res.status(400).json({ error: 'Bad versionId' });

  // prev_version_id = MAX(version_id) strictly below this one for (server,zone).
  const prevRow = await db('mob_spawn_cell_versions')
    .where({ server_id: serverId, zone_no: zoneNo })
    .andWhereRaw('version_id < ?', [vRaw])
    .max('version_id as prev')
    .first();
  const prevVersionId = prevRow && prevRow.prev != null ? String(prevRow.prev) : null;

  // Renewed cells for THIS version. Cap the scan (mirror CLUSTER_CELL_SCAN);
  // typical_group is computed per cell so a spot can classify group changes.
  const thisCells = await db('mob_spawn_cell_versions')
    .where({ server_id: serverId, zone_no: zoneNo, version_id: vRaw })
    .select('mob_id', 'cell_x', 'cell_z', 'channel', 'y_avg', 'hits', 'passes', 'instance_sum')
    .orderBy('hits', 'desc')
    .limit(DETAIL_CELL_SCAN);
  const truncated = thisCells.length >= DETAIL_CELL_SCAN;

  // Prev-version cells keyed on the /diff spot key (mob_id,cell_x,cell_z,channel)
  // → typicalGroup, for per-cell classification. Empty map when no prev session.
  const typGroup = (hits, inst) => (inst == null ? 0 : Number(inst)) / Math.max(1, hits == null ? 0 : Number(hits));
  const spotKey  = (mobId, cx, cz, ch) => `${mobId}|${cx}|${cz}|${ch}`;
  const prevByKey = new Map();
  if (prevVersionId != null) {
    const prevCells = await db('mob_spawn_cell_versions')
      .where({ server_id: serverId, zone_no: zoneNo, version_id: prevVersionId })
      .select('mob_id', 'cell_x', 'cell_z', 'channel', 'hits', 'instance_sum')
      .limit(DETAIL_CELL_SCAN);
    for (const p of prevCells) {
      prevByKey.set(spotKey(p.mob_id, p.cell_x, p.cell_z, p.channel), typGroup(p.hits, p.instance_sum));
    }
  }

  // Per-CELL change classification vs prev (same semantics as /diff, prev→this).
  // Stamp each cell with ._change so the spot roll-up can pick a dominant status.
  const seenThisKeys = new Set();
  for (const c of thisCells) {
    const k = spotKey(c.mob_id, c.cell_x, c.cell_z, c.channel);
    seenThisKeys.add(k);
    if (!prevByKey.has(k)) {
      c._change = 'new';
    } else {
      const gPrev = prevByKey.get(k);
      const gThis = typGroup(c.hits, c.instance_sum);
      c._change = Math.abs(gPrev - gThis) > 1e-9 ? 'group_changed' : 'same';
    }
  }

  // Aggregate changes{added,removed,group_changed,same} at the spot-key level —
  // added/group_changed/same come from this session's cells (added == 'new');
  // removed = prev spot keys absent from this session (only counted when a prev
  // session exists). Mirrors /diff's prev=a / this=b buckets.
  const changes = { added: 0, removed: 0, group_changed: 0, same: 0 };
  for (const c of thisCells) {
    if (c._change === 'new')                changes.added += 1;
    else if (c._change === 'group_changed') changes.group_changed += 1;
    else                                    changes.same += 1;
  }
  if (prevVersionId != null) {
    for (const k of prevByKey.keys()) {
      if (!seenThisKeys.has(k)) changes.removed += 1;
    }
  }

  // World-coord frame (optional). When present, center = origin + cell*cell_size_m.
  const bounds = await db('zone_bounds')
    .where({ server_id: serverId, zone_no: zoneNo })
    .select('origin_x', 'origin_z', 'cell_size_m')
    .first();
  const cellSize = bounds && bounds.cell_size_m != null ? Number(bounds.cell_size_m) : null;
  const originX  = bounds ? Number(bounds.origin_x) : null;
  const originZ  = bounds ? Number(bounds.origin_z) : null;
  const worldX = (cellCentroidX) =>
    cellSize != null ? originX + cellCentroidX * cellSize : cellCentroidX;
  const worldZ = (cellCentroidZ) =>
    cellSize != null ? originZ + cellCentroidZ * cellSize : cellCentroidZ;

  // Group cells by mob, then agglomerate each mob's cells into spots via the
  // SHARED helper. onCell tallies each spot's member-cell change classes so the
  // spot can roll up to a dominant status.
  const byMob = new Map();
  for (const c of thisCells) {
    if (!byMob.has(c.mob_id)) byMob.set(c.mob_id, []);
    byMob.get(c.mob_id).push(c);
  }

  const renewed = [];
  for (const [mobId, cells] of byMob) {
    const spots = agglomerateCells(cells, (cluster, cell) => {
      cluster._nNew    = (cluster._nNew    || 0) + (cell._change === 'new'           ? 1 : 0);
      cluster._nChg    = (cluster._nChg    || 0) + (cell._change === 'group_changed' ? 1 : 0);
      cluster._nCells  = (cluster._nCells  || 0) + 1;
    }).map((cl) => {
      // Dominant spot status: 'new' if any/most member cells new, else
      // 'group_changed' if any group-changed, else 'same'.
      let change;
      if ((cl._nNew || 0) > 0)      change = 'new';
      else if ((cl._nChg || 0) > 0) change = 'group_changed';
      else                          change = 'same';
      return {
        center_x:      worldX(cl.center_x),
        center_z:      worldZ(cl.center_z),
        // Raw cell-space centroid too, so the map deep-link can match the
        // MonsterMap cluster nodes (which are in CELL units) regardless of
        // whether a zone_bounds frame turned center_x/z into world metres.
        cell_x:        cl.center_x,
        cell_z:        cl.center_z,
        y_avg:         cl.y_avg,
        cell_count:    cl.cells,
        hits:          cl.hits,
        instance_sum:  cl.instance_sum,
        typical_group: cl.typical_group,
        reliability:   cl.reliability,
        density_score: cl.density_score,
        change,
      };
    });
    renewed.push({ mob_id: mobId, spots });
  }

  // Densest spot first within each mob, mobs by total spot density, capped to
  // DETAIL_SPOT_LIMIT spots overall (mirror CLUSTER_LIMIT).
  for (const g of renewed) g.spots.sort((a, b) => b.density_score - a.density_score);
  renewed.sort((a, b) => {
    const da = a.spots.reduce((s, x) => s + x.density_score, 0);
    const db2 = b.spots.reduce((s, x) => s + x.density_score, 0);
    return db2 - da;
  });
  let spotBudget = DETAIL_SPOT_LIMIT;
  const cappedRenewed = [];
  for (const g of renewed) {
    if (spotBudget <= 0) break;
    const spots = g.spots.slice(0, spotBudget);
    spotBudget -= spots.length;
    cappedRenewed.push({ mob_id: g.mob_id, spot_count: spots.length, spots });
  }

  // Mob names — one keyed lookup over mob_catalog (LEFT JOIN semantics).
  const mobIds = cappedRenewed.map(g => g.mob_id);
  const nameByMob = new Map();
  if (mobIds.length) {
    const catRows = await db('mob_catalog')
      .where('server_id', serverId)
      .whereIn('mob_id', mobIds)
      .select('mob_id', 'name');
    for (const cr of catRows) nameByMob.set(cr.mob_id, cr.name);
  }
  for (const g of cappedRenewed) g.mob_name = nameByMob.get(g.mob_id) ?? null;

  res.json({
    server_id:       serverId,
    zone_no:         zoneNo,
    version_id:      vRaw,
    prev_version_id: prevVersionId,
    // `mobs` + `summary` are the names the client (endpoints.js worldApi.sessionDetail
    // + WorldSessions SessionDetail) consumes. Kept as the sole response contract.
    mobs: cappedRenewed.map(g => ({
      mob_id:     g.mob_id,
      mob_name:   g.mob_name,
      spot_count: g.spot_count,
      spots:      g.spots,
    })),
    summary: changes,
    truncated,
  });
});

export default router;
