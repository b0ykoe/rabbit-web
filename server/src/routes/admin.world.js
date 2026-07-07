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

// ── Reference-name import upload (035) ───────────────────────────────────────
// The bot writes names.json / zones.csv / mobs.csv locally now; a super_admin
// uploads ONE of those files here. Name lists are tiny compared to a background
// image, so a 16 MB cap is plenty. Same DISK-into-_tmp multer convention as the
// zone-map upload, and the same wrapper for a clean 400 on an over-limit body.
const NAMES_MAX_BYTES = 16 * 1024 * 1024;
const NAMES_MAX_MB    = Math.round(NAMES_MAX_BYTES / (1024 * 1024));

const namesUpload = multer({
  dest: path.join(config.bot.privateDir, '_tmp'),
  limits: { fileSize: NAMES_MAX_BYTES },
});

function namesUploadSingle(req, res, next) {
  namesUpload.single('file')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        error: tooBig ? `File too large (max ${NAMES_MAX_MB} MB)` : 'Upload failed',
      });
    }
    next();
  });
}

// RFC-4180-tolerant CSV parser. Handles quoted fields, doubled quotes inside a
// quoted field, and CRLF or LF line endings. Returns an array of row arrays
// (each row an array of string cells). A trailing empty line is dropped. Kept
// deliberately small — the reference lists are two columns of short strings.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }   // doubled quote
        inQuotes = false; i += 1; continue;                            // closing quote
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }                             // swallow CR (CRLF or bare)
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  // Flush the final field/row unless the file ended on a clean newline (which
  // already pushed the row and left an empty field with an empty row buffer).
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
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
    // zone_named_count / mob_named_count (035) + npc_named_count (036) count the
    // REFERENCE name rows so the admin sees how complete the name lists are.
    const [mobCounts, cellCounts, hostRows, zoneNameCounts, mobNameCounts, npcNameCounts] = await Promise.all([
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
      db('game_zones').whereIn('server_id', ids)
        .groupBy('server_id')
        .select('server_id', db.raw('COUNT(*) as zone_named_count')),
      db('mob_names').whereIn('server_id', ids)
        .groupBy('server_id')
        .select('server_id', db.raw('COUNT(*) as mob_named_count')),
      db('game_npcs').whereIn('server_id', ids)
        .groupBy('server_id')
        .select('server_id', db.raw('COUNT(*) as npc_named_count')),
    ]);
    const mobMap  = Object.fromEntries(mobCounts.map(c => [c.server_id, Number(c.mob_count)]));
    const cellMap = Object.fromEntries(cellCounts.map(c => [c.server_id, c]));
    const zoneNameMap = Object.fromEntries(zoneNameCounts.map(c => [c.server_id, Number(c.zone_named_count)]));
    const mobNameMap  = Object.fromEntries(mobNameCounts.map(c => [c.server_id, Number(c.mob_named_count)]));
    const npcNameMap  = Object.fromEntries(npcNameCounts.map(c => [c.server_id, Number(c.npc_named_count)]));
    const ipsMap  = new Map();
    for (const h of hostRows) {
      if (!ipsMap.has(h.server_id)) ipsMap.set(h.server_id, []);
      ipsMap.get(h.server_id).push(h.ip);
    }
    for (const s of servers) {
      const cc = cellMap[s.id];
      s.visible           = !!s.visible;   // normalize mysql2 0/1
      s.mob_count         = mobMap[s.id]  || 0;
      s.cell_count        = cc ? Number(cc.cell_count) : 0;
      s.sightings_total   = cc ? Number(cc.sightings_total || 0) : 0;
      s.zone_named_count  = zoneNameMap[s.id] || 0;
      s.mob_named_count   = mobNameMap[s.id]  || 0;
      s.npc_named_count   = npcNameMap[s.id]  || 0;
      s.known_ips         = ipsMap.get(s.id) || [];
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
    // 035: also purge the server's reference zone + monster name lists.
    c.game_zones              = await trx('game_zones').where('server_id', id).del();
    c.mob_names               = await trx('mob_names').where('server_id', id).del();
    // 036: also purge the server's reference NPC name list.
    c.game_npcs               = await trx('game_npcs').where('server_id', id).del();
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
// Per-server DRILL-IN OVERVIEW (035 reference lists + coverage). Super-admin-only.
// Answers "what is this server missing" for the admin manage panel: the zone
// universe (every zone that carries ANY signal) with per-zone name/data/bounds/
// background flags + rollup counts, and the full monster name list (searchable).
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/world/servers/:id/overview — coverage + reference-name drill-in.
//   Response: { counts:{ zones_total, zones_named, mobs_named, npcs_named,
//                         missing_name, missing_background, missing_data,
//                         missing_bounds },
//               zones:[{ zone_no, name|null, has_data, has_bounds, has_background }],
//               mobs:[{ mob_id, name }],
//               npcs:[{ npc_id, name, type, zone_no }] }
router.get('/servers/:id/overview', requireSuperAdmin, async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serverId) || serverId < 0) {
    return res.status(400).json({ error: 'Bad server id' });
  }

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const MOB_CAP = 5000;   // cap the monster-name list returned to the panel.
  const NPC_CAP = 5000;   // cap the NPC-name list returned to the panel.
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  // Zone universe = DISTINCT zone_no UNION across the four per-zone signals:
  // named zones (game_zones), framed bounds (zone_bounds), background images
  // (zone_maps), and spawn data (mob_spawn_cells). Built in JS (like the
  // zone-maps coverage handler) so an orphan in any one source still surfaces.
  // mobsTotal / npcsTotal are UNFILTERED counts so the mobs_named / npcs_named
  // rollups stay accurate even when the ?q search narrows / the caps truncate the
  // returned lists. The NPC ?q filter matches name OR type (or an exact npc_id).
  const [nameZones, boundZones, imageZones, dataZones, mobRows, mobsTotalRow, npcRows, npcsTotalRow] = await Promise.all([
    db('game_zones').where('server_id', serverId).select('zone_no', 'name'),
    db('zone_bounds').where('server_id', serverId).distinct('zone_no').select('zone_no'),
    db('zone_maps').where('server_id', serverId).distinct('zone_no').select('zone_no'),
    db('mob_spawn_cells').where('server_id', serverId).distinct('zone_no').select('zone_no'),
    (() => {
      let mq = db('mob_names').where('server_id', serverId)
        .select('mob_id', 'name');
      if (q) {
        mq = mq.where(function () {
          this.where('name', 'like', `%${q}%`);
          const asId = parseInt(q, 10);
          if (Number.isFinite(asId)) this.orWhere('mob_id', asId);
        });
      }
      return mq.orderBy('mob_id', 'asc').limit(MOB_CAP);
    })(),
    db('mob_names').where('server_id', serverId).count('* as c').first(),
    (() => {
      let nq = db('game_npcs').where('server_id', serverId)
        .select('npc_id', 'name', 'type', 'zone_no');
      if (q) {
        nq = nq.where(function () {
          this.where('name', 'like', `%${q}%`)
              .orWhere('type', 'like', `%${q}%`);
          const asId = parseInt(q, 10);
          if (Number.isFinite(asId)) this.orWhere('npc_id', asId);
        });
      }
      return nq.orderBy('npc_id', 'asc').limit(NPC_CAP);
    })(),
    db('game_npcs').where('server_id', serverId).count('* as c').first(),
  ]);
  const mobsTotal = Number(mobsTotalRow?.c ?? 0);
  const npcsTotal = Number(npcsTotalRow?.c ?? 0);

  const nameByZone = new Map(nameZones.map(r => [r.zone_no, r.name]));
  const boundsSet  = new Set(boundZones.map(r => r.zone_no));
  const imageSet   = new Set(imageZones.map(r => r.zone_no));
  const dataSet    = new Set(dataZones.map(r => r.zone_no));

  const zoneSet = new Set();
  for (const r of nameZones)  zoneSet.add(r.zone_no);
  for (const r of boundZones) zoneSet.add(r.zone_no);
  for (const r of imageZones) zoneSet.add(r.zone_no);
  for (const r of dataZones)  zoneSet.add(r.zone_no);

  const zones = [...zoneSet].sort((a, b) => a - b).map((zone_no) => ({
    zone_no,
    name:           nameByZone.has(zone_no) ? nameByZone.get(zone_no) : null,
    has_data:       dataSet.has(zone_no),
    has_bounds:     boundsSet.has(zone_no),
    has_background: imageSet.has(zone_no),
  }));

  const counts = {
    zones_total:        zones.length,
    zones_named:        zones.filter(z => z.name != null).length,
    mobs_named:         mobsTotal,
    npcs_named:         npcsTotal,
    missing_name:       zones.filter(z => z.name == null).length,
    missing_background: zones.filter(z => !z.has_background).length,
    missing_data:       zones.filter(z => !z.has_data).length,
    missing_bounds:     zones.filter(z => !z.has_bounds).length,
  };

  res.json({
    counts,
    zones,
    mobs: mobRows.map(r => ({ mob_id: r.mob_id, name: r.name })),
    npcs: npcRows.map(r => ({ npc_id: r.npc_id, name: r.name, type: r.type, zone_no: r.zone_no })),
  });
});

// POST /api/admin/world/servers/:id/import-names — REPLACE-ALL import of a
// server's reference ZONE + MONSTER + NPC name tables from an admin-uploaded file
// (field 'file'). The bot writes names.json / zones.csv / mobs.csv / npcs.csv
// locally; the GM uploads ONE of them here (no user may push into the panel —
// only a super_admin imports). Format is DETECTED from the content: a body whose
// first non-whitespace char is '{' or '[' is JSON ({zones?:[{zone_no,name}],
// mobs?:[{mob_id,name}], npcs?:[{npc_id,name,type,zone_no}]}); otherwise it is
// CSV, and the list is identified by the header row (zone_no,name → zones ;
// mob_id,name → mobs ; npc_id,name,type,zone_no → npcs). Valid rows REPLACE the
// server's rows for each list PRESENT, in ONE transaction (exactly like the old
// bot ingest); a list absent from the file is left untouched.
router.post('/servers/:id/import-names', requireSuperAdmin, namesUploadSingle, async (req, res) => {
  const serverId = parseInt(req.params.id, 10);

  // Clean up the staged temp file on any return.
  const cleanupTmp = () => { try { if (req.file) fs.unlinkSync(req.file.path); } catch { /* ignore */ } };

  if (!Number.isFinite(serverId) || serverId < 0) {
    cleanupTmp();
    return res.status(400).json({ error: 'Bad server id' });
  }
  if (!req.file) return res.status(400).json({ error: 'File is required (field "file")' });

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) { cleanupTmp(); return res.status(404).json({ error: 'Server not found' }); }

  // Read the staged bytes.
  let text;
  try { text = fs.readFileSync(req.file.path, 'utf8'); }
  catch { cleanupTmp(); return res.status(400).json({ error: 'Could not read upload' }); }

  // Strip a UTF-8 BOM so JSON.parse / the CSV header match cleanly.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const trimmed = text.replace(/^\s+/, '');
  if (!trimmed) { cleanupTmp(); return res.status(400).json({ error: 'Empty file' }); }

  // Row limits (mirror the old ingest caps): zones ≤4000, mobs ≤60000, npcs ≤60000.
  const ZONE_CAP = 4000;
  const MOB_CAP  = 60000;
  const NPC_CAP  = 60000;

  // Collected + validated rows. null = list absent from the file (leave the
  // server's rows untouched); an array (even empty) = list present → REPLACE-ALL.
  let zones = null;   // [{ zone_no, name }]
  let mobs  = null;   // [{ mob_id, name }]
  let npcs  = null;   // [{ npc_id, name, type, zone_no }]

  // Validators: zone_no int 0..65535 + name 1..128; mob_id int >=1 + name 1..96;
  // npc_id int >=1 + name 1..96 + optional type ≤32 + optional zone_no 0..65535.
  const takeZone = (zoneNoRaw, nameRaw) => {
    const zoneNo = Number.parseInt(zoneNoRaw, 10);
    const name = typeof nameRaw === 'string' ? nameRaw : (nameRaw == null ? '' : String(nameRaw));
    if (!Number.isInteger(zoneNo) || zoneNo < 0 || zoneNo > 65535) return null;
    if (name.length < 1 || name.length > 128) return null;
    return { zone_no: zoneNo, name };
  };
  const takeMob = (mobIdRaw, nameRaw) => {
    const mobId = Number.parseInt(mobIdRaw, 10);
    const name = typeof nameRaw === 'string' ? nameRaw : (nameRaw == null ? '' : String(nameRaw));
    if (!Number.isInteger(mobId) || mobId < 1) return null;
    if (name.length < 1 || name.length > 96) return null;
    return { mob_id: mobId, name };
  };
  // type/zone_no are OPTIONAL: an empty/blank/absent type → null; a missing or
  // out-of-range zone_no → null (a named NPC with no placement is still valid).
  const takeNpc = (npcIdRaw, nameRaw, typeRaw, zoneNoRaw) => {
    const npcId = Number.parseInt(npcIdRaw, 10);
    const name = typeof nameRaw === 'string' ? nameRaw : (nameRaw == null ? '' : String(nameRaw));
    if (!Number.isInteger(npcId) || npcId < 1) return null;
    if (name.length < 1 || name.length > 96) return null;
    let type = typeof typeRaw === 'string' ? typeRaw : (typeRaw == null ? '' : String(typeRaw));
    type = type.trim();
    if (type.length === 0) type = null;
    else if (type.length > 32) type = type.slice(0, 32);
    let zoneNo = null;
    if (zoneNoRaw != null && !(typeof zoneNoRaw === 'string' && zoneNoRaw.trim() === '')) {
      const zn = Number.parseInt(zoneNoRaw, 10);
      if (Number.isInteger(zn) && zn >= 0 && zn <= 65535) zoneNo = zn;
    }
    return { npc_id: npcId, name, type, zone_no: zoneNo };
  };

  const firstChar = trimmed[0];
  if (firstChar === '{' || firstChar === '[') {
    // ── JSON path ──────────────────────────────────────────────────────────
    let parsed;
    try { parsed = JSON.parse(trimmed); }
    catch { cleanupTmp(); return res.status(400).json({ error: 'Invalid JSON' }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      cleanupTmp();
      return res.status(400).json({ error: 'JSON must be an object with zones/mobs' });
    }
    if (Array.isArray(parsed.zones)) {
      zones = [];
      for (const z of parsed.zones) {
        if (!z || typeof z !== 'object') continue;
        const v = takeZone(z.zone_no, z.name);
        if (v) zones.push(v);
      }
    }
    if (Array.isArray(parsed.mobs)) {
      mobs = [];
      for (const m of parsed.mobs) {
        if (!m || typeof m !== 'object') continue;
        const v = takeMob(m.mob_id, m.name);
        if (v) mobs.push(v);
      }
    }
    if (Array.isArray(parsed.npcs)) {
      npcs = [];
      for (const n of parsed.npcs) {
        if (!n || typeof n !== 'object') continue;
        const v = takeNpc(n.npc_id, n.name, n.type, n.zone_no);
        if (v) npcs.push(v);
      }
    }
    if (zones == null && mobs == null && npcs == null) {
      cleanupTmp();
      return res.status(400).json({ error: 'JSON has no zones, mobs or npcs array' });
    }
  } else {
    // ── CSV path ───────────────────────────────────────────────────────────
    const rows = parseCsv(text);
    // Drop leading fully-empty rows, then read the header.
    let start = 0;
    while (start < rows.length && rows[start].every(c => c.trim() === '')) start += 1;
    if (start >= rows.length) { cleanupTmp(); return res.status(400).json({ error: 'Empty CSV' }); }
    const header = rows[start].map(c => c.trim().toLowerCase());
    const isZoneCsv = header[0] === 'zone_no' && header[1] === 'name';
    const isMobCsv  = header[0] === 'mob_id'  && header[1] === 'name';
    // NPC CSV: npc_id,name,type,zone_no. type/zone_no are optional per-row (blank
    // cells → null); the header is matched only on the first two columns being
    // npc_id,name so a trailing-column mismatch does not reject a valid file.
    const isNpcCsv  = header[0] === 'npc_id'  && header[1] === 'name';
    if (!isZoneCsv && !isMobCsv && !isNpcCsv) {
      cleanupTmp();
      return res.status(400).json({ error: 'CSV header must be "zone_no,name", "mob_id,name" or "npc_id,name,type,zone_no"' });
    }
    const dataRows = rows.slice(start + 1);
    if (isZoneCsv) {
      zones = [];
      for (const r of dataRows) {
        if (r.length === 1 && r[0].trim() === '') continue;   // skip blank line
        const v = takeZone(r[0], r[1]);
        if (v) zones.push(v);
      }
    } else if (isMobCsv) {
      mobs = [];
      for (const r of dataRows) {
        if (r.length === 1 && r[0].trim() === '') continue;   // skip blank line
        const v = takeMob(r[0], r[1]);
        if (v) mobs.push(v);
      }
    } else {
      npcs = [];
      for (const r of dataRows) {
        if (r.length === 1 && r[0].trim() === '') continue;   // skip blank line
        const v = takeNpc(r[0], r[1], r[2], r[3]);
        if (v) npcs.push(v);
      }
    }
  }

  const now = nowSec();

  // Dedupe on the PK (a later occurrence wins) BEFORE the replace-all so the bulk
  // insert never trips a duplicate-key on its own batch. Cap after dedupe.
  const zoneRows = zones != null
    ? [...new Map(zones.map(z => [z.zone_no, {
        server_id: serverId, zone_no: z.zone_no, name: z.name, updated_at: now,
      }])).values()].slice(0, ZONE_CAP)
    : null;
  const mobRows = mobs != null
    ? [...new Map(mobs.map(m => [m.mob_id, {
        server_id: serverId, mob_id: m.mob_id, name: m.name, updated_at: now,
      }])).values()].slice(0, MOB_CAP)
    : null;
  const npcRows = npcs != null
    ? [...new Map(npcs.map(n => [n.npc_id, {
        server_id: serverId, npc_id: n.npc_id, name: n.name,
        type: n.type, zone_no: n.zone_no, updated_at: now,
      }])).values()].slice(0, NPC_CAP)
    : null;

  // REPLACE-ALL per list present, per server, in ONE transaction: DELETE the
  // server's rows then bulk-insert the fresh set in ~500-row batches. A list
  // ABSENT from the file (null) is left untouched.
  const BATCH = 500;
  try {
    await db.transaction(async (trx) => {
      if (zoneRows) {
        await trx('game_zones').where('server_id', serverId).del();
        for (let i = 0; i < zoneRows.length; i += BATCH) {
          await trx('game_zones').insert(zoneRows.slice(i, i + BATCH));
        }
      }
      if (mobRows) {
        await trx('mob_names').where('server_id', serverId).del();
        for (let i = 0; i < mobRows.length; i += BATCH) {
          await trx('mob_names').insert(mobRows.slice(i, i + BATCH));
        }
      }
      if (npcRows) {
        await trx('game_npcs').where('server_id', serverId).del();
        for (let i = 0; i < npcRows.length; i += BATCH) {
          await trx('game_npcs').insert(npcRows.slice(i, i + BATCH));
        }
      }
    });
  } catch {
    cleanupTmp();
    return res.status(500).json({ error: 'Import failed' });
  }

  cleanupTmp();

  await recordAudit(db, req, {
    action: 'world.names.import', subjectType: 'game_server', subjectId: String(serverId),
    newValues: {
      orig_name: (req.file.originalname || '').slice(0, 255) || null,
      zones: zoneRows ? zoneRows.length : null,
      mobs:  mobRows  ? mobRows.length  : null,
      npcs:  npcRows  ? npcRows.length  : null,
    },
  });

  res.json({
    ok: true,
    zones: zoneRows ? zoneRows.length : 0,
    mobs:  mobRows  ? mobRows.length  : 0,
    npcs:  npcRows  ? npcRows.length  : 0,
  });
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
