//
// admin.world.js — monster-map ingest-token administration (PLAN_v2 §3.9).
//
// Super-admin-gated. Lets a GM mint an authoritative scope:'ingest' token,
// signed with the same ed25519 signer as every other bot token, that a Debug
// bot can paste to push spawns to the ingest route. Each mint inserts an
// issued_ingest_tokens row so the token can be listed and per-token revoked
// (flip `revoked`) without a license_version bump.
//
//   POST   /api/admin/world/ingest-token        { user_id | license_key } → mint
//   GET    /api/admin/world/ingest-tokens                                 → list
//   DELETE /api/admin/world/ingest-token/:jti                             → revoke
//
// The signed payload mirrors the live session token shape (key/jti/tvr/exp/
// iat/ver) plus scope:'ingest', so validateSpawnIngest's non-ingest branch
// still works for the live path and the ingest branch keys on the issued row.
//

import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { config } from '../config.js';
import { signToken, generateJti } from '../crypto/ed25519.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { recordAudit } from '../services/auditLog.js';
import { generateKey } from '../services/licenseService.js';
import { validate, ingestTokenMintSchema, serverCreateSchema, serverUpdateSchema } from '../validation/schemas.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Per-(server, zone) BACKGROUND MAP IMAGE uploads (031_zone_maps). Reuses the
// Releases multer/storage/serve convention verbatim: DISK-backed multer into a
// _tmp dir under BOT_PRIVATE_DIR, then renameSync out to a deterministic path.
// The image BYTES live under <privateDir>/zone_maps/; only a meta row lives in
// zone_maps. All routes here are super-admin-only + audited (matches the
// server-mgmt precedent). The ingest-token + server-mgmt routes are untouched.
// ─────────────────────────────────────────────────────────────────────────────

// Where the image files live on disk. Sibling of the Releases dll/loader dirs
// under the same private root so the same BOT_PRIVATE_DIR env governs both.
const ZONE_MAP_DIR = path.join(config.bot.privateDir, 'zone_maps');
// 150 MB cap for a single background image. Zone maps are large: a 4096 PNG can
// be 60-70 MB (zone_0_4096.png is ~65 MB), and a hybrid SVG that embeds a 2048
// terrain raster adds more. NOTE: nginx client_max_body_size MUST be >= this or
// the proxy 413s before the body ever reaches multer.
const ZONE_MAP_MAX_BYTES = 150 * 1024 * 1024;
const ZONE_MAP_MAX_MB    = Math.round(ZONE_MAP_MAX_BYTES / (1024 * 1024));

// DISK multer into the shared _tmp staging dir (identical to Releases). No
// fileFilter here — we enforce type by MIME *and* magic bytes in the route so a
// spoofed Content-Type can't smuggle a non-image through. Size capped at 150 MB.
const zoneMapUpload = multer({
  dest: path.join(config.bot.privateDir, '_tmp'),
  limits: { fileSize: ZONE_MAP_MAX_BYTES },
});

// Wrap multer.single so an over-limit upload (or any multer error) returns a
// clean 400 JSON instead of bubbling a MulterError to the generic error handler
// (which logs "[error] MulterError: File too large" and 500s the request).
function zoneMapUploadSingle(req, res, next) {
  zoneMapUpload.single('file')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        error: tooBig ? `File too large (max ${ZONE_MAP_MAX_MB} MB)` : 'Upload failed',
      });
    }
    next();
  });
}

// PNG 8-byte signature.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Sniff format from the first bytes of the file. Returns 'png' | 'svg' | null.
// SVG detection is lenient: skip a UTF-8 BOM / leading whitespace, then require
// the document to start with '<?xml' or '<svg' (case-insensitive) within the
// first chunk. This is defensive against a spoofed content_type header.
function sniffImageFormat(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  // Skip a UTF-8 BOM if present.
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  const head = buf.subarray(start, start + 1024).toString('utf8').replace(/^\s+/, '').toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'svg';
  return null;
}

// Best-effort pixel dimensions. PNG: IHDR width/height at fixed offsets. SVG:
// width/height attrs (integer px) or the viewBox w/h. Returns {width,height} or
// {width:null,height:null} — dimensions are advisory only, never load-bearing.
function readImageDims(buf, format) {
  try {
    if (format === 'png' && buf.length >= 24 && buf.subarray(0, 8).equals(PNG_MAGIC)) {
      // IHDR is the first chunk: length(4)+type(4) then width(4)+height(4) BE.
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (format === 'svg') {
      const txt = buf.subarray(0, 4096).toString('utf8');
      const w = /\bwidth\s*=\s*["']\s*([\d.]+)\s*(px)?\s*["']/i.exec(txt);
      const h = /\bheight\s*=\s*["']\s*([\d.]+)\s*(px)?\s*["']/i.exec(txt);
      if (w && h) return { width: Math.round(parseFloat(w[1])), height: Math.round(parseFloat(h[1])) };
      const vb = /\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(txt);
      if (vb) return { width: Math.round(parseFloat(vb[1])), height: Math.round(parseFloat(vb[2])) };
    }
  } catch { /* dims are advisory — swallow */ }
  return { width: null, height: null };
}

// Seeding-key window bounds. Default 6h (short-lived), hard cap 72h. The caller
// picks the window via duration_hours; the token exp and the issued row's
// expires_at are both derived from it so they stay coherent.
const DEFAULT_DURATION_HOURS = 6;
const MAX_DURATION_HOURS     = 72;

function nowSec() { return Math.floor(Date.now() / 1000); }

// POST /api/admin/world/ingest-token — mint a scoped ingest token.
router.post('/ingest-token', requireSuperAdmin, validate(ingestTokenMintSchema), async (req, res) => {
  const { self, user_id, license_key, duration_hours } = req.validated;

  // SELF path when explicitly requested OR when neither selector is given: the
  // token binds to the REQUESTING super_admin (the route is already super-admin
  // gated), so a GM can mint many distribution tokens under their own identity
  // WITHOUT picking a user/license. The explicit user_id/license_key path below
  // keeps its exact behavior (resolution + 1-active-token cap) unchanged.
  const isSelf = self === true || (user_id == null && !license_key);

  // Resolve a real, active license: SELF → the admin's own first active license
  // (auto-created if none); else directly by key, or the target user's first
  // active license. The token MUST carry a valid license `key` + its current
  // token_version so the live-token checks stay coherent.
  let license;
  if (isSelf) {
    const adminUserId = req.session.user.id;
    license = await db('licenses')
      .where({ user_id: adminUserId, active: true })
      .orderBy('created_at', 'asc')
      .first();
    // No active license for this admin → AUTO-CREATE a minimal one so the
    // recording service always has a coherent key/token_version to sign against.
    if (!license) {
      const key = generateKey();
      await db('licenses').insert({
        license_key:  key,
        user_id:      adminUserId,
        max_sessions: 1,
        active:       true,
        note:         'recording service (auto)',
        expires_at:   null,
        // token_version left to its column default.
      });
      license = await db('licenses').where({ license_key: key }).first();
    }
  } else if (license_key) {
    license = await db('licenses').where({ license_key, active: true }).first();
  } else {
    license = await db('licenses')
      .where({ user_id, active: true })
      .orderBy('created_at', 'asc')
      .first();
  }
  if (!license) {
    return res.status(404).json({ error: 'No active license found for that user/key' });
  }

  // HARDENING: cap ONE active ingest token per user. Reject (409) if the target
  // user already holds a LIVE token (revoked=false AND expires_at>now). We do NOT
  // auto-revoke the existing one — the admin must explicitly DELETE it first,
  // so a live seeding key is never silently invalidated out from under a bot.
  // Keyed on the resolved license.user_id (server-side identity), matching the
  // validateSpawnIngest live-row check. A license with a NULL user_id (orphan)
  // skips the cap — there is no user identity to rate-limit against.
  //
  // SELF path is EXEMPT from the cap: the admin mints MANY distribution tokens,
  // so a single-active-token limit would be wrong here.
  if (!isSelf && license.user_id != null) {
    const activeToken = await db('issued_ingest_tokens')
      .where({ user_id: license.user_id, revoked: false })
      .andWhere('expires_at', '>', nowSec())
      .first();
    if (activeToken) {
      return res.status(409).json({
        error: 'User already has an active ingest token; revoke it before minting a new one',
        jti:   activeToken.jti,
      });
    }
  }

  // Clamp the requested window to [1h, MAX]. schema defaults to 6h, but re-clamp
  // here so the route is safe even if called with a raw/looser validator.
  const hours = Math.min(
    MAX_DURATION_HOURS,
    Math.max(1, Number.isFinite(duration_hours) ? duration_hours : DEFAULT_DURATION_HOURS),
  );
  const now = nowSec();
  const expiresAt = now + hours * 60 * 60;
  const jti = generateJti();

  const token = await signToken({
    key:   license.license_key,
    jti,
    tvr:   license.token_version || 1,
    scope: 'ingest',
    exp:   expiresAt,
    iat:   now,
    ver:   1,
  }, config.bot.ed25519PrivateKey);

  await db('issued_ingest_tokens').insert({
    jti,
    user_id:     license.user_id || null,
    license_key: license.license_key,
    scope:       'ingest',
    revoked:     false,
    expires_at:  expiresAt,
    created_at:  now,
  });

  await recordAudit(db, req, {
    action: 'world.ingest_token.mint', subjectType: 'license', subjectId: license.license_key,
    newValues: { jti, user_id: license.user_id || null, expires_at: expiresAt, duration_hours: hours },
  });

  res.status(201).json({ token, jti, expires_at: expiresAt, duration_hours: hours });
});

// GET /api/admin/world/ingest-tokens — list issued tokens (never the token itself).
router.get('/ingest-tokens', requireSuperAdmin, async (req, res) => {
  const rows = await db('issued_ingest_tokens')
    .leftJoin('users', 'issued_ingest_tokens.user_id', 'users.id')
    .select(
      'issued_ingest_tokens.jti',
      'issued_ingest_tokens.user_id',
      'issued_ingest_tokens.license_key',
      'issued_ingest_tokens.scope',
      'issued_ingest_tokens.revoked',
      'issued_ingest_tokens.expires_at',
      'issued_ingest_tokens.created_at',
      'users.name as user_name',
      'users.email as user_email',
    )
    .orderBy('issued_ingest_tokens.created_at', 'desc')
    .limit(200);

  // Normalize booleans (mysql2 returns 0/1).
  for (const r of rows) r.revoked = !!r.revoked;

  res.json({ data: rows });
});

// DELETE /api/admin/world/ingest-token/:jti — revoke (soft; keeps the audit row).
router.delete('/ingest-token/:jti', requireSuperAdmin, async (req, res) => {
  const { jti } = req.params;
  const row = await db('issued_ingest_tokens').where('jti', jti).first();
  if (!row) return res.status(404).json({ error: 'Token not found' });

  await db('issued_ingest_tokens').where('jti', jti).update({ revoked: true });
  await recordAudit(db, req, {
    action: 'world.ingest_token.revoke', subjectType: 'license', subjectId: row.license_key,
    oldValues: { revoked: !!row.revoked }, newValues: { revoked: true, jti },
  });

  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-server management (PLAN_v2 admin). Unlike the public portal /servers read,
// these expose ALL rows (including visible=false) so a GM can review + publish
// (visible), rename (display_name), or purge a server. All three are
// super-admin-only + audited, matching the ingest-token precedent above. The
// ingest-token routes are untouched.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/world/servers — ALL servers (incl. hidden) with coverage counts
// and their known IPs (034 game_server_hosts).
router.get('/servers', requireSuperAdmin, async (req, res) => {
  const servers = await db('game_servers')
    .select('id', 'name', 'ip', 'variant', 'port', 'display_name', 'visible', 'first_seen', 'last_seen')
    .orderBy('last_seen', 'desc')
    .limit(500);

  if (servers.length) {
    const ids = servers.map(s => s.id);
    // Coverage counts so the admin sees what data a server carries before
    // publishing or deleting it: distinct mobs, spawn cells, and total sightings.
    // known_ips (034) lists the game socket IPs registered for each server.
    const [mobCounts, cellCounts, hostRows] = await Promise.all([
      db('mob_catalog').whereIn('server_id', ids)
        .groupBy('server_id')
        .select('server_id', db.raw('COUNT(*) as mob_count')),
      db('mob_spawn_cells').whereIn('server_id', ids)
        .groupBy('server_id')
        .select(
          'server_id',
          db.raw('COUNT(*) as cell_count'),
          db.raw('SUM(`hits`) as sightings_total'),
        ),
      db('game_server_hosts').whereIn('server_id', ids)
        .whereNotNull('ip')
        .select('server_id', 'ip'),
    ]);
    const mobMap  = Object.fromEntries(mobCounts.map(c => [c.server_id, Number(c.mob_count)]));
    const cellMap = Object.fromEntries(cellCounts.map(c => [c.server_id, c]));
    const ipsMap  = new Map();
    for (const h of hostRows) {
      if (!ipsMap.has(h.server_id)) ipsMap.set(h.server_id, []);
      ipsMap.get(h.server_id).push(h.ip);
    }
    for (const s of servers) {
      const cc = cellMap[s.id];
      s.visible         = !!s.visible;   // normalize mysql2 0/1
      s.mob_count       = mobMap[s.id]  || 0;
      s.cell_count      = cc ? Number(cc.cell_count) : 0;
      s.sightings_total = cc ? Number(cc.sightings_total || 0) : 0;
      s.known_ips       = ipsMap.get(s.id) || [];
    }
  }

  res.json({ data: servers });
});

// POST /api/admin/world/servers — create an admin-defined NAMED server (034).
// name + variant required; visible defaults false. known_ips seed
// game_server_hosts (deduped on the UNIQUE(ip) — a duplicate IP is skipped).
router.post('/servers', requireSuperAdmin, validate(serverCreateSchema), async (req, res) => {
  const { name, variant, visible, known_ips } = req.validated;
  const now = nowSec();

  const trimmedName = name.trim();
  const trimmedVariant = variant.trim();
  if (!trimmedName || !trimmedVariant) {
    return res.status(422).json({ error: 'name and variant are required' });
  }

  const serverId = await db.transaction(async (trx) => {
    const [id] = await trx('game_servers').insert({
      name:         trimmedName,
      // ip/variant/port are vestigial (034) — variant kept for legacy resolve;
      // ip left null (the host-map owns per-server IPs now).
      ip:           null,
      variant:      trimmedVariant,
      port:         null,
      display_name: trimmedName,
      visible:      visible === true,
      first_seen:   now,
      last_seen:    now,
    });

    // Seed known IPs; dedupe on the game_server_hosts UNIQUE(ip). A collision
    // (an IP already owned by another server) is skipped, not an error.
    const seedIps = Array.isArray(known_ips)
      ? [...new Set(known_ips.map(ip => (ip || '').trim()).filter(Boolean))]
      : [];
    for (const ip of seedIps) {
      const exists = await trx('game_server_hosts').where('ip', ip).select('id').first();
      if (exists) continue;
      await trx('game_server_hosts').insert({ server_id: id, ip, port: null });
    }
    return id;
  });

  const row = await db('game_servers').where('id', serverId).first();
  row.visible = !!row.visible;
  const ips = await db('game_server_hosts')
    .where('server_id', serverId).whereNotNull('ip').pluck('ip');
  row.known_ips = ips;

  await recordAudit(db, req, {
    action: 'world.server.create', subjectType: 'game_server', subjectId: String(serverId),
    newValues: { name: trimmedName, variant: trimmedVariant, visible: row.visible, known_ips: ips },
  });

  res.status(201).json({ data: row });
});

// PATCH /api/admin/world/servers/:id — edit name/variant/display_name/visible
// and/or add or remove known IPs (034). Any single field is enough (schema
// refine). IP mutations touch game_server_hosts; an add that collides with an
// IP already owned elsewhere (UNIQUE(ip)) is skipped rather than 500ing.
router.patch('/servers/:id', requireSuperAdmin, validate(serverUpdateSchema), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad server id' });

  const existing = await db('game_servers').where('id', id).first();
  if (!existing) return res.status(404).json({ error: 'Server not found' });

  const patch = {};
  if (req.validated.display_name !== undefined) {
    const dn = req.validated.display_name;
    patch.display_name = dn == null ? null : dn.trim() || null;
  }
  if (req.validated.name !== undefined) {
    patch.name = req.validated.name.trim() || null;
  }
  if (req.validated.variant !== undefined) {
    patch.variant = req.validated.variant.trim() || existing.variant;
  }
  if (req.validated.visible !== undefined) patch.visible = req.validated.visible;

  const addIps = Array.isArray(req.validated.add_ips)
    ? [...new Set(req.validated.add_ips.map(ip => (ip || '').trim()).filter(Boolean))]
    : [];
  const removeIps = Array.isArray(req.validated.remove_ips)
    ? [...new Set(req.validated.remove_ips.map(ip => (ip || '').trim()).filter(Boolean))]
    : [];

  await db.transaction(async (trx) => {
    if (Object.keys(patch).length) {
      await trx('game_servers').where('id', id).update(patch);
    }
    for (const ip of addIps) {
      const owner = await trx('game_server_hosts').where('ip', ip).select('server_id').first();
      if (owner) {
        // Already registered — only insert-skip when it's a foreign owner; a
        // re-add to THIS server is a no-op either way.
        continue;
      }
      await trx('game_server_hosts').insert({ server_id: id, ip, port: null });
    }
    if (removeIps.length) {
      await trx('game_server_hosts')
        .where('server_id', id)
        .whereIn('ip', removeIps)
        .del();
    }
  });

  const row = await db('game_servers').where('id', id).first();
  row.visible = !!row.visible;
  row.known_ips = await db('game_server_hosts')
    .where('server_id', id).whereNotNull('ip').pluck('ip');

  await recordAudit(db, req, {
    action: 'world.server.update', subjectType: 'game_server', subjectId: String(id),
    oldValues: {
      name: existing.name, variant: existing.variant,
      display_name: existing.display_name, visible: !!existing.visible,
    },
    newValues: { ...patch, add_ips: addIps, remove_ips: removeIps },
  });

  res.json({ data: row });
});

// DELETE /api/admin/world/servers/:id — CASCADE purge the server + all its data.
// No FK constraints exist, so children are deleted explicitly, child-tables
// first, in ONE transaction. Order: version tables → spawn cells → catalog →
// zone bounds → the server row itself.
router.delete('/servers/:id', requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad server id' });

  const existing = await db('game_servers').where('id', id).first();
  if (!existing) return res.status(404).json({ error: 'Server not found' });

  const counts = await db.transaction(async (trx) => {
    const c = {};
    c.mob_spawn_cell_versions = await trx('mob_spawn_cell_versions').where('server_id', id).del();
    c.spawn_version_meta      = await trx('spawn_version_meta').where('server_id', id).del();
    c.mob_spawn_cells         = await trx('mob_spawn_cells').where('server_id', id).del();
    c.mob_catalog             = await trx('mob_catalog').where('server_id', id).del();
    c.zone_bounds             = await trx('zone_bounds').where('server_id', id).del();
    // 034: also purge the server's registered host IPs.
    c.game_server_hosts       = await trx('game_server_hosts').where('server_id', id).del();
    c.game_servers            = await trx('game_servers').where('id', id).del();
    return c;
  });

  await recordAudit(db, req, {
    action: 'world.server.delete', subjectType: 'game_server', subjectId: String(id),
    oldValues: { ip: existing.ip, variant: existing.variant, display_name: existing.display_name },
    newValues: { deleted: true, counts },
  });

  res.json({ deleted: true, counts });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zone background-map images (031_zone_maps). Super-admin-only + audited.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/world/servers/:id/zone-maps — coverage list. Every zone that
// HAS DATA (distinct zone_no across mob_spawn_cells UNION zone_bounds), each
// annotated with has_bounds / has_image (+ image meta). Drives the
// "which zones are MISSING a background" admin UI.
router.get('/servers/:id/zone-maps', requireSuperAdmin, async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serverId)) return res.status(400).json({ error: 'Bad server id' });

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) return res.status(404).json({ error: 'Server not found' });

  // Zones with data: distinct zone_no from spawn cells and from framed bounds.
  const [cellZones, boundZones, imageRows] = await Promise.all([
    db('mob_spawn_cells').where('server_id', serverId).distinct('zone_no').select('zone_no'),
    db('zone_bounds').where('server_id', serverId).distinct('zone_no').select('zone_no'),
    db('zone_maps').where('server_id', serverId)
      .select('zone_no', 'format', 'orig_name', 'byte_size', 'width', 'height', 'uploaded_at'),
  ]);

  const boundsSet = new Set(boundZones.map(r => r.zone_no));
  const imageMap  = new Map(imageRows.map(r => [r.zone_no, r]));

  // Union of all zones that carry ANY data (cells or bounds) OR an uploaded
  // image — so an orphan image (row/file exists but the data was purged) stays
  // visible in the coverage list and can still be deleted.
  const zoneSet = new Set();
  for (const r of cellZones)  zoneSet.add(r.zone_no);
  for (const r of boundZones) zoneSet.add(r.zone_no);
  for (const r of imageRows)  zoneSet.add(r.zone_no);

  const zones = [...zoneSet].sort((a, b) => a - b).map((zone_no) => {
    const img = imageMap.get(zone_no) || null;
    return {
      zone_no,
      has_bounds: boundsSet.has(zone_no),
      has_image:  !!img,
      image: img ? {
        format:      img.format,
        orig_name:   img.orig_name,
        byte_size:   img.byte_size,
        width:       img.width,
        height:      img.height,
        uploaded_at: img.uploaded_at,
      } : null,
    };
  });

  res.json({ data: zones });
});

// POST /api/admin/world/servers/:id/zones/:zoneNo/map — upload ONE background
// image (field 'file'). Accepts svg or png only, validated by MIME + magic
// bytes, ≤150 MB. Stored under <privateDir>/zone_maps/ with a deterministic,
// path-free name. UPSERTs the zone_maps row (removes any prior file first).
router.post('/servers/:id/zones/:zoneNo/map', requireSuperAdmin, zoneMapUploadSingle, async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  const zoneNo   = parseInt(req.params.zoneNo, 10);

  // Clean up the staged temp file on any early return.
  const cleanupTmp = () => { try { if (req.file) fs.unlinkSync(req.file.path); } catch { /* ignore */ } };

  if (!Number.isFinite(serverId) || serverId < 0 || !Number.isFinite(zoneNo) || zoneNo < 0) {
    cleanupTmp();
    return res.status(400).json({ error: 'Bad server id / zone' });
  }
  if (!req.file) return res.status(400).json({ error: 'File is required (field "file")' });

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) { cleanupTmp(); return res.status(404).json({ error: 'Server not found' }); }

  // Read staged bytes and validate type by MIME *and* magic bytes.
  let buf;
  try { buf = fs.readFileSync(req.file.path); } catch { cleanupTmp(); return res.status(400).json({ error: 'Could not read upload' }); }

  if (buf.length === 0) { cleanupTmp(); return res.status(400).json({ error: 'Empty file' }); }
  if (buf.length > ZONE_MAP_MAX_BYTES) { cleanupTmp(); return res.status(400).json({ error: `File too large (max ${ZONE_MAP_MAX_MB} MB)` }); }

  const sniffed = sniffImageFormat(buf);
  const mime = (req.file.mimetype || '').toLowerCase();
  const mimeOk = mime === 'image/svg+xml' || mime === 'image/png';
  // Require BOTH a plausible MIME AND matching magic bytes; and the sniffed
  // format must agree with the declared MIME (no PNG-as-SVG smuggling).
  const mimeFormat = mime === 'image/png' ? 'png' : (mime === 'image/svg+xml' ? 'svg' : null);
  if (!mimeOk || !sniffed || sniffed !== mimeFormat) {
    cleanupTmp();
    return res.status(400).json({ error: 'Only PNG or SVG images are accepted' });
  }

  const format       = sniffed;                 // 'png' | 'svg'
  const ext          = format === 'png' ? '.png' : '.svg';
  const content_type  = format === 'png' ? 'image/png' : 'image/svg+xml';
  const { width, height } = readImageDims(buf, format);

  // Deterministic, path-free filename: `${serverId}_${zoneNo}.<ext>`.
  const file_name = `${serverId}_${zoneNo}${ext}`;

  if (!fs.existsSync(ZONE_MAP_DIR)) fs.mkdirSync(ZONE_MAP_DIR, { recursive: true });

  // Remove any prior file for this (server, zone) — including the OTHER format,
  // so switching svg→png (or back) never orphans the old file.
  const prior = await db('zone_maps').where({ server_id: serverId, zone_no: zoneNo }).first();
  if (prior && prior.file_name) {
    try { fs.unlinkSync(path.join(ZONE_MAP_DIR, prior.file_name)); } catch { /* already gone */ }
  }
  // Also defensively unlink both possible target names before renaming in.
  for (const e of ['.png', '.svg']) {
    if (e === ext) continue;
    try { fs.unlinkSync(path.join(ZONE_MAP_DIR, `${serverId}_${zoneNo}${e}`)); } catch { /* ignore */ }
  }

  const filePath = path.join(ZONE_MAP_DIR, file_name);
  try {
    fs.renameSync(req.file.path, filePath);
  } catch {
    cleanupTmp();
    return res.status(400).json({ error: 'Could not store file' });
  }

  const uploaded_at = Math.floor(Date.now() / 1000);
  const uploaded_by = req.session?.user?.id ?? null;

  const row = {
    server_id: serverId,
    zone_no:   zoneNo,
    format,
    file_name,
    orig_name: (req.file.originalname || '').slice(0, 255) || null,
    content_type,
    byte_size: buf.length,
    width,
    height,
    uploaded_by,
    uploaded_at,
  };

  // UPSERT (delete-then-insert; PK is composite (server_id, zone_no)).
  await db('zone_maps').where({ server_id: serverId, zone_no: zoneNo }).del();
  await db('zone_maps').insert(row);

  await recordAudit(db, req, {
    action: 'world.zone_map.upload', subjectType: 'zone_map', subjectId: `${serverId}:${zoneNo}`,
    oldValues: prior ? { format: prior.format, orig_name: prior.orig_name, byte_size: prior.byte_size } : null,
    newValues: { format, orig_name: row.orig_name, byte_size: row.byte_size, width, height },
  });

  res.status(201).json({ data: row });
});

// DELETE /api/admin/world/servers/:id/zones/:zoneNo/map — remove the file + row.
router.delete('/servers/:id/zones/:zoneNo/map', requireSuperAdmin, async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  const zoneNo   = parseInt(req.params.zoneNo, 10);
  if (!Number.isFinite(serverId) || !Number.isFinite(zoneNo)) {
    return res.status(400).json({ error: 'Bad server id / zone' });
  }

  const row = await db('zone_maps').where({ server_id: serverId, zone_no: zoneNo }).first();
  if (!row) return res.status(404).json({ error: 'No background image for that zone' });

  if (row.file_name) {
    try { fs.unlinkSync(path.join(ZONE_MAP_DIR, row.file_name)); } catch { /* already gone */ }
  }
  await db('zone_maps').where({ server_id: serverId, zone_no: zoneNo }).del();

  await recordAudit(db, req, {
    action: 'world.zone_map.delete', subjectType: 'zone_map', subjectId: `${serverId}:${zoneNo}`,
    oldValues: { format: row.format, orig_name: row.orig_name, byte_size: row.byte_size },
    newValues: { deleted: true },
  });

  res.json({ deleted: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin CSV export of a server's spawn heat (F3 — ADMIN ONLY, audited). Streams
// UNCAPPED (does NOT inherit the portal CELL_LIMIT) by keyset-paging the spot
// key (mob_id, cell_x, cell_z, channel) in fixed-size pages and writing each
// page's rows straight to the response. Density formulas mirror portal.world.js
// verbatim so a CSV ranks identically to the on-screen map.
// ─────────────────────────────────────────────────────────────────────────────

// LOCKED, append-only CSV column order. NEVER reorder or remove — only append.
const CSV_COLUMNS = [
  'server_id', 'zone_no', 'mob_id', 'mob_name', 'channel',
  'cell_x', 'cell_z', 'world_x', 'world_z', 'world_y',
  'hits', 'passes', 'instance_sum',
  'reliability', 'typical_group', 'density_score',
  'version_id', 'first_seen_sec', 'last_seen_sec',
];

const CSV_PAGE = 2000;   // rows fetched per keyset page (internal; export is uncapped)

// Parse the ?version query exactly like portal.world.js parseVersionParam:
//   absent/'all' → all-time table; 'latest' → newest-per-spot; '<digits>' → exact.
// Returns { kind:'all'|'latest'|'exact', version? } or null for a malformed value.
function parseCsvVersion(v) {
  if (v == null || v === '') return { kind: 'all' };
  if (typeof v !== 'string')  return null;
  const s = v.trim().toLowerCase();
  if (s === 'all')    return { kind: 'all' };
  if (s === 'latest') return { kind: 'latest' };
  if (/^\d+$/.test(s)) return { kind: 'exact', version: s };
  return null;
}

function csvIntParam(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Comma-separated int list ("3,5,7") → [3,5,7], sanitized + capped.
function csvIntList(v, max = 64) {
  if (typeof v !== 'string' || !v) return [];
  return v.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite).slice(0, max);
}

// RFC-4180 + spreadsheet-formula-injection safe field encoder. Any field whose
// first character is one of = + - @ (or a leading TAB/CR) is prefixed with a
// single apostrophe so a spreadsheet never evaluates it as a formula; then the
// whole field is double-quoted with internal quotes doubled. null/undefined → "".
function csvField(val) {
  let s = (val == null) ? '' : String(val);
  if (s.length > 0) {
    const c = s[0];
    if (c === '=' || c === '+' || c === '-' || c === '@' || c === '\t' || c === '\r') {
      s = `'${s}`;
    }
  }
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(values) {
  return values.map(csvField).join(',') + '\r\n';
}

// GET /api/admin/world/servers/:id/spawns.csv — stream the full spawn heat.
router.get('/servers/:id/spawns.csv', requireSuperAdmin, async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serverId) || serverId < 0) {
    return res.status(400).json({ error: 'Bad server id' });
  }

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const version = parseCsvVersion(req.query.version);
  if (!version) return res.status(400).json({ error: 'Bad version (use all|latest|<number>)' });

  const zoneNo         = csvIntParam(req.query.zone_no);
  const mobId          = csvIntParam(req.query.mob_id);
  const channel        = csvIntParam(req.query.channel);
  const ignoreChannels = csvIntList(req.query.ignore_channels);

  // Bounds for world-coord projection: world = origin + cell*cell_size_m. A zone
  // filter picks that zone's row; without a zone filter, world coords stay blank
  // (a server can hold many zones with different origins — no single projection).
  let bounds = null;
  if (zoneNo != null) {
    bounds = await db('zone_bounds')
      .where({ server_id: serverId, zone_no: zoneNo })
      .select('origin_x', 'origin_z', 'cell_size_m')
      .first();
  }
  const cellSize = bounds && bounds.cell_size_m != null ? Number(bounds.cell_size_m) : null;

  // ── Shared WHERE fragment (server always; zone/mob/channel optional) ─────────
  // Channel semantics mirror the portal read: `channel = N OR channel = 0`
  // includes the agnostic/legacy bucket; ignore_channels → NOT IN (...).
  const whereClauses = ['server_id = ?'];
  const whereBinds   = [serverId];
  if (zoneNo != null)  { whereClauses.push('zone_no = ?'); whereBinds.push(zoneNo); }
  if (mobId  != null)  { whereClauses.push('mob_id = ?');  whereBinds.push(mobId);  }
  if (channel != null) { whereClauses.push('(channel = ? OR channel = 0)'); whereBinds.push(channel); }
  if (ignoreChannels.length) {
    whereClauses.push(`channel NOT IN (${ignoreChannels.map(() => '?').join(',')})`);
    whereBinds.push(...ignoreChannels);
  }

  // Source table + whether a version_id column exists. all-time = mob_spawn_cells
  // (no version_id → blank in the CSV); latest/exact = mob_spawn_cell_versions.
  const versioned = version.kind !== 'all';
  const sourceTable = versioned ? 'mob_spawn_cell_versions' : 'mob_spawn_cells';

  // Exact version → extra predicate; latest → handled in the window layer.
  const verClauses = [...whereClauses];
  const verBinds   = [...whereBinds];
  if (version.kind === 'exact') { verClauses.push('version_id = ?'); verBinds.push(version.version); }

  // Density exprs qualified to the spot source alias `s` (the JOIN with
  // mob_catalog would make bare `hits`/`instance_sum` ambiguous only in theory,
  // but qualifying is unconditionally safe).
  const relExpr     = '((`s`.`hits` + 1) / (`s`.`passes` + 2))';
  const groupExpr   = '(`s`.`instance_sum` / GREATEST(`s`.`hits`, 1))';
  const densityExpr = `${relExpr} * ${groupExpr}`;

  // Columns pulled per page. LEFT JOIN mob_catalog for mob_name (name column).
  // versioned tables expose version_id; the all-time table does not, so it is
  // only selected when present. All source columns qualified with `s.`.
  const baseCols =
    's.server_id, s.zone_no, s.mob_id, s.channel, s.cell_x, s.cell_z, s.y_avg, ' +
    's.hits, s.passes, s.instance_sum, s.first_seen_sec, s.last_seen_sec' +
    (versioned ? ', s.version_id' : '') +
    ', mc.name AS mob_name, ' +
    `${relExpr} AS reliability, ${groupExpr} AS typical_group, ${densityExpr} AS density_score`;

  // The LEFT JOIN is keyed on the catalog's (server_id, mob_id) PK.
  const joinSql = 'LEFT JOIN mob_catalog mc ON mc.server_id = s.server_id AND mc.mob_id = s.mob_id';

  // Keyset-paged fetch. Deterministic ORDER BY the FULL source key led by zone_no
  // (zone_no, mob_id, cell_x, cell_z, channel); each page seeks strictly past the
  // last tuple of the prior page so the export is UNCAPPED without ever buffering
  // the whole result set. zone_no MUST lead: on a whole-server export (no ?zone_no)
  // two rows in different zones can share the same 4-tuple, and without zone_no in
  // the sort/cursor a tie group straddling a page boundary would be silently
  // dropped. For 'latest' the ROW_NUMBER window partitions by zone_no too, so each
  // (zone,spot) collapses to one row and this 5-tuple keyset stays unique.
  //
  // Bind order is INNER-then-OUTER: the base filter (verBinds) lands wherever the
  // filter clause is placed, then the keyset cursor binds always come last.
  const orderLimit = 'ORDER BY s.zone_no ASC, s.mob_id ASC, s.cell_x ASC, s.cell_z ASC, s.channel ASC ' + `LIMIT ${CSV_PAGE}`;

  // Qualified `s.` copy of the base filter for the flat (non-latest) path.
  const qualifiedFilter = verClauses.map(c => c
    .replace(/\bserver_id\b/g, 's.server_id')
    .replace(/\bzone_no\b/g, 's.zone_no')
    .replace(/\bmob_id\b/g, 's.mob_id')
    .replace(/\bchannel\b/g, 's.channel')
    .replace(/\bversion_id\b/g, 's.version_id')).join(' AND ');

  // (zone_no, mob_id, cell_x, cell_z, channel) > (?, ?, ?, ?, ?) — row-value seek,
  // `s.`-qualified, zone_no leading (total order over the full source key).
  const KEYSET_CLAUSE = '(s.zone_no > ? OR (s.zone_no = ? AND (s.mob_id > ? OR (s.mob_id = ? AND (s.cell_x > ? OR (s.cell_x = ? AND (s.cell_z > ? OR (s.cell_z = ? AND s.channel > ?))))))))';
  function keysetBinds(cursor) {
    return [cursor.zone_no, cursor.zone_no, cursor.mob_id, cursor.mob_id, cursor.cell_x, cursor.cell_x, cursor.cell_z, cursor.cell_z, cursor.channel];
  }

  async function fetchPage(cursor) {
    let sql;
    let binds;
    if (version.kind === 'latest') {
      // Newest revision per spot: the base filter runs in the INNER subquery
      // (unqualified, plain source select); mob_catalog + rn=1 + keyset run in the
      // OUTER. Inner binds first, then keyset binds.
      const innerWhere = verClauses.join(' AND ');
      const outerParts = ['s.rn = 1'];
      binds = [...verBinds];
      if (cursor) { outerParts.push(KEYSET_CLAUSE); binds.push(...keysetBinds(cursor)); }
      sql =
        `SELECT ${baseCols} FROM (` +
          `SELECT *, ROW_NUMBER() OVER (` +
            `PARTITION BY server_id, zone_no, mob_id, cell_x, cell_z, channel ` +
            `ORDER BY version_id DESC) AS rn ` +
          `FROM ${sourceTable} WHERE ${innerWhere}` +
        `) s ${joinSql} WHERE ${outerParts.join(' AND ')} ${orderLimit}`;
    } else {
      // Flat path: filter + keyset in one WHERE, all `s.`-qualified. Filter binds
      // first, then keyset binds.
      const parts = [qualifiedFilter];
      binds = [...verBinds];
      if (cursor) { parts.push(KEYSET_CLAUSE); binds.push(...keysetBinds(cursor)); }
      sql = `SELECT ${baseCols} FROM ${sourceTable} s ${joinSql} WHERE ${parts.join(' AND ')} ${orderLimit}`;
    }
    const result = await db.raw(sql, binds);
    return Array.isArray(result) ? result[0] : (result.rows || result);
  }

  // FIXED, server-controlled filename — never interpolate mob/zone free text into
  // the header (only numeric ids, sanitized above).
  const fname = `spawns_server${serverId}` + (zoneNo != null ? `_zone${zoneNo}` : '') + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  // Header row (locked order).
  res.write(csvRow(CSV_COLUMNS));

  let cursor = null;
  let total  = 0;
  try {
    for (;;) {
      const rows = await fetchPage(cursor);
      if (!rows || rows.length === 0) break;

      for (const r of rows) {
        // world_x/z = origin + cell*cell_size_m; blank when no bounds row.
        let worldX = '';
        let worldZ = '';
        if (bounds && cellSize != null) {
          worldX = Number(bounds.origin_x) + Number(r.cell_x) * cellSize;
          worldZ = Number(bounds.origin_z) + Number(r.cell_z) * cellSize;
        }
        // version_id as a PLAIN integer string (bigint-safe; all-time → blank).
        const versionOut = (r.version_id == null) ? '' : String(r.version_id);

        res.write(csvRow([
          r.server_id,
          r.zone_no,
          r.mob_id,
          r.mob_name ?? '',
          r.channel,
          r.cell_x,
          r.cell_z,
          worldX,
          worldZ,
          r.y_avg == null ? '' : r.y_avg,
          r.hits,
          r.passes,
          r.instance_sum,
          Number(r.reliability),
          Number(r.typical_group),
          Number(r.density_score),
          versionOut,
          r.first_seen_sec,
          r.last_seen_sec,
        ]));
      }

      total += rows.length;
      const last = rows[rows.length - 1];
      cursor = { zone_no: last.zone_no, mob_id: last.mob_id, cell_x: last.cell_x, cell_z: last.cell_z, channel: last.channel };
      if (rows.length < CSV_PAGE) break;   // last page
    }
    res.end();
  } catch (err) {
    // If nothing was flushed yet we can still send a clean 500; once the stream
    // has started we can only terminate it.
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
    else res.end();
    return;
  }

  await recordAudit(db, req, {
    action: 'world.spawns.export_csv', subjectType: 'game_server', subjectId: String(serverId),
    newValues: {
      zone_no: zoneNo, mob_id: mobId, channel, ignore_channels: ignoreChannels,
      version: version.kind === 'exact' ? version.version : version.kind, rows: total,
    },
  });
});

export default router;
