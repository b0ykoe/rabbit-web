//
// admin.offsets.js — offset-override administration (Phase D, migration 038).
//
// The SERVER side of the signed offset-override system. Model: base = compiled
// "Stock EP4" GameLayout; each server = base + a few field overrides, keyed by
// the target Engine.dll build (TimeDateStamp/SizeOfImage). A super_admin sets
// the fingerprint + overrides, then SIGNS them into a blob with a SEPARATE,
// password-encrypted Ed25519 key (NOT the always-hot bot-token key). The bot
// (Phase E) verifies the blob's signature with its compiled pubkey before it
// trusts any value → a forged blob is inert.
//
//   GET  /offset-key                     → { exists, public_key_hex|null }
//   POST /offset-key/generate            → mint the signing key (409 if exists)
//   POST /offset-catalog/import (file)   → REPLACE-ALL the field catalog
//   GET  /servers/:id/offsets            → fingerprint + catalog + overrides
//   PUT  /servers/:id/offsets            → set fingerprint + REPLACE overrides
//   POST /servers/:id/offsets/sign       → sign the blob (403 on wrong password)
//
// All routes are super_admin-only + audited, matching the admin.world.js
// precedent. Mounted under /api/admin/world in index.js. SECURITY INVARIANTS:
// the private key is stored ONLY encrypted; the password is NEVER stored /
// logged / audited; NO endpoint ever returns enc_private_key; a wrong password
// fails cleanly (403); PUT invalidates the signed blob; field_names are
// validated against the catalog.
//

import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { config } from '../config.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { recordAudit } from '../services/auditLog.js';
import { validate, offsetKeyGenSchema, offsetsPutSchema, offsetSignSchema,
         templateCreateSchema, templateUpdateSchema, templateValuesPutSchema } from '../validation/schemas.js';
import { generateKeypair, buildBlob, OffsetKeyAuthError } from '../crypto/offsetSigning.js';

const router = Router();

function nowSec() { return Math.floor(Date.now() / 1000); }

// The single signing-key row is always id=1 (one key for the whole portal).
const KEY_ROW_ID = 1;

// ── Field-catalog import upload ──────────────────────────────────────────────
// Same DISK-into-_tmp multer convention + clean-400 wrapper as the names-import
// path in admin.world.js. The catalog JSON is tiny; a 16 MB cap is plenty.
const CATALOG_MAX_BYTES = 16 * 1024 * 1024;
const CATALOG_MAX_MB    = Math.round(CATALOG_MAX_BYTES / (1024 * 1024));

const catalogUpload = multer({
  dest: path.join(config.bot.privateDir, '_tmp'),
  limits: { fileSize: CATALOG_MAX_BYTES },
});

function catalogUploadSingle(req, res, next) {
  catalogUpload.single('file')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        error: tooBig ? `File too large (max ${CATALOG_MAX_MB} MB)` : 'Upload failed',
      });
    }
    next();
  });
}

// ── GET /offset-key ──────────────────────────────────────────────────────────
// Report whether a signing key exists + expose the PUBLIC key only. NEVER the
// enc_private_key (the private material is password-wrapped and stays server-side).
router.get('/offset-key', requireSuperAdmin, async (req, res) => {
  // Defense-in-depth: SELECT only the public columns so the encrypted private key
  // is never even materialised in this handler's row object.
  const row = await db('offset_signing_keys').where('id', KEY_ROW_ID).first(['id', 'public_key_hex']);
  res.json({
    exists:         !!row,
    public_key_hex: row ? row.public_key_hex : null,
  });
});

// ── POST /offset-key/generate ────────────────────────────────────────────────
// Mint the signing key. 409 if a key row already exists (rotation is a separate,
// deliberate operation — we never silently overwrite a live key). The password
// wraps the private key at rest and is NEVER stored/logged/audited.
router.post('/offset-key/generate', requireSuperAdmin, validate(offsetKeyGenSchema), async (req, res) => {
  const { password } = req.validated;

  const existing = await db('offset_signing_keys').where('id', KEY_ROW_ID).first();
  if (existing) {
    return res.status(409).json({ error: 'A signing key already exists' });
  }

  const { public_key_hex, enc_private_key } = await generateKeypair(password);
  const now = nowSec();
  await db('offset_signing_keys').insert({
    id:              KEY_ROW_ID,
    public_key_hex,
    enc_private_key,
    created_at:      now,
  });

  // Audit the key genesis — public key only, NEVER the password or enc key.
  await recordAudit(db, req, {
    action: 'world.offset_key.generate', subjectType: 'offset_signing_key', subjectId: String(KEY_ROW_ID),
    newValues: { public_key_hex },
  });

  res.status(201).json({ public_key_hex });
});

// ── POST /offset-catalog/import ──────────────────────────────────────────────
// REPLACE-ALL import of the bot-exported field catalog. Body (field 'file') is a
// JSON array of { field_name, kind: "data"|"va", criticality?, base_value?:int|null }.
// Invalid rows (bad field_name / bad kind) are DROPPED; the whole catalog is
// replaced in ONE transaction. Responds { ok, count } — count = rows written.
router.post('/offset-catalog/import', requireSuperAdmin, catalogUploadSingle, async (req, res) => {
  const cleanupTmp = () => { try { if (req.file) fs.unlinkSync(req.file.path); } catch { /* ignore */ } };

  if (!req.file) return res.status(400).json({ error: 'File is required (field "file")' });

  let text;
  try { text = fs.readFileSync(req.file.path, 'utf8'); }
  catch { cleanupTmp(); return res.status(400).json({ error: 'Could not read upload' }); }
  cleanupTmp();

  // Strip a UTF-8 BOM so JSON.parse matches cleanly.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return res.status(400).json({ error: 'File is not valid JSON' }); }

  // Accept EITHER a bare array of catalog entries OR the shape the bot's Dev >
  // Exporter tab actually writes: an object { kind:"rabbit-offsets", fields:[…] }.
  // (offsets_catalog.json is an object; a hand-authored list may be a bare array.)
  const entries = Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray(parsed.fields)) ? parsed.fields
    : null;
  if (!entries) {
    return res.status(400).json({ error: 'Expected the bot\'s offsets_catalog.json (or a JSON array of field entries)' });
  }

  // Cap the catalog so a hostile upload can't drive an unbounded write (the whole
  // GameLayout is a few hundred fields).
  const CATALOG_CAP = 2000;

  // Validate + normalize. kind ∈ {data,va}; field_name 1..64; criticality ≤16 or
  // null; base_value an integer or null. Bad rows dropped. Later duplicate
  // field_names overwrite earlier ones (last-wins) so the map stays PK-clean.
  // The bot exporter keys each field as `name` + `base_default` (Stock EP4) /
  // `value` (active variant), so accept those aliases too — base_value is the
  // Stock EP4 baseline, preferring base_default over the active value.
  const now = nowSec();
  const byName = new Map();          // field_name -> catalog row (name/kind/crit/base)
  const activeByName = new Map();    // field_name -> ACTIVE value (running variant)
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const rawName = (typeof e.field_name === 'string' && e.field_name) ? e.field_name
      : (typeof e.name === 'string' ? e.name : '');
    const fieldName = rawName.trim();
    if (fieldName.length < 1 || fieldName.length > 64) continue;
    const kind = typeof e.kind === 'string' ? e.kind.trim().toLowerCase() : '';
    if (kind !== 'data' && kind !== 'va') continue;

    let criticality = null;
    if (e.criticality != null) {
      const c = String(e.criticality).trim();
      if (c) criticality = c.slice(0, 16);
    }

    // Stock baseline for this field: explicit base_value, else the exporter's
    // base_default (engine_variant_base). This is what the SEED template holds.
    const rawBase = e.base_value != null ? e.base_value
      : e.base_default != null ? e.base_default
      : null;
    let baseValue = null;
    if (rawBase != null) {
      const bv = Number(rawBase);
      if (Number.isInteger(bv)) baseValue = bv;
    }

    // ACTIVE value on the exporting machine (the running variant, e.g. Nemesis).
    // Used below to auto-derive that server's overrides = fields where it differs
    // from the Stock base. Falls back to the base when no separate `value`.
    const rawActive = e.value != null ? e.value : rawBase;
    if (rawActive != null) {
      const av = Number(rawActive);
      if (Number.isInteger(av)) activeByName.set(fieldName, av);
    }

    byName.set(fieldName, {
      field_name: fieldName,
      kind,
      criticality,
      base_value: baseValue,
      updated_at: now,
    });
    if (byName.size >= CATALOG_CAP) break;
  }

  const rows = [...byName.values()];

  // The import feeds a BUILD TEMPLATE (the Stock base) and — when the export knows
  // which server it came from — auto-derives that server's OVERRIDES (its deltas
  // from Stock, e.g. Nemesis). template_name + target_server_id are optional multer
  // form fields; otherwise the template defaults to "Stock EP4" and the target is
  // the server_id the bot recorded in the export.
  const templateName = (typeof req.body?.template_name === 'string' && req.body.template_name.trim())
    ? req.body.template_name.trim().slice(0, 64)
    : 'Stock EP4';
  let targetServerId = 0;
  const bodySid   = Number(req.body?.target_server_id);
  const exportSid = Number(parsed?.server_id);
  if (Number.isInteger(bodySid) && bodySid > 0) targetServerId = bodySid;
  else if (Number.isInteger(exportSid) && exportSid > 0) targetServerId = exportSid;

  let templateId = null;
  let overrideCount = 0;
  let appliedServerId = null;

  await db.transaction(async (trx) => {
    // 1) REPLACE-ALL the global field universe (names / kinds / criticality / base).
    await trx('offset_field_catalog').del();
    if (rows.length) await trx('offset_field_catalog').insert(rows);

    // 2) Upsert the build template from the Stock base values (REPLACE-ALL its set).
    const existingTpl = await trx('build_templates').where('name', templateName).first();
    if (existingTpl) {
      templateId = existingTpl.id;
      await trx('build_templates').where('id', templateId).update({ updated_at: now });
    } else {
      const [id] = await trx('build_templates').insert({
        name: templateName, notes: 'Imported from a bot offset catalog.',
        created_at: now, updated_at: now,
      });
      templateId = id;
    }
    await trx('template_field_values').where('template_id', templateId).del();
    const tplRows = rows
      .filter(r => r.base_value != null)
      .map(r => ({ template_id: templateId, field_name: r.field_name, value: r.base_value }));
    if (tplRows.length) await trx('template_field_values').insert(tplRows);

    // 3) Auto-derive the exporting server's overrides = fields whose ACTIVE value
    //    differs from the Stock base. Points the server at this template, REPLACE-ALL
    //    its overrides, and clears any stale signed blob (content changed).
    if (targetServerId > 0) {
      const srv = await trx('game_servers').where('id', targetServerId).select('id').first();
      if (srv) {
        const overrideRows = [];
        for (const r of rows) {
          if (r.base_value == null) continue;
          const av = activeByName.get(r.field_name);
          if (av == null || av === r.base_value) continue;   // no delta
          overrideRows.push({ server_id: targetServerId, field_name: r.field_name, value: av, updated_at: now });
        }
        await trx('game_servers').where('id', targetServerId).update({
          offset_template_id: templateId,
          offset_signed_blob: null,
          offset_signed_at:   null,
        });
        await trx('server_offset_overrides').where('server_id', targetServerId).del();
        if (overrideRows.length) await trx('server_offset_overrides').insert(overrideRows);
        overrideCount   = overrideRows.length;
        appliedServerId = targetServerId;
      }
    }
  });

  await recordAudit(db, req, {
    action: 'world.offset_catalog.import', subjectType: 'offset_field_catalog',
    newValues: { count: rows.length, template_id: templateId, template_name: templateName,
                 applied_server_id: appliedServerId, override_count: overrideCount },
  });

  res.json({
    ok: true, count: rows.length,
    template_id: templateId, template_name: templateName,
    applied_server_id: appliedServerId, override_count: overrideCount,
  });
});

// ── GET /servers/:id/offsets ─────────────────────────────────────────────────
// The per-server offset view for the admin panel: the engine fingerprint, the
// full catalog, this server's overrides, and an EFFECTIVE join (base ± override).
// 404 if the server is missing.
router.get('/servers/:id/offsets', requireSuperAdmin, async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serverId) || serverId < 0) {
    return res.status(400).json({ error: 'Bad server id' });
  }

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const templateId = server.offset_template_id != null ? Number(server.offset_template_id) : null;

  const [catalogRows, overrideRows, templateValueRows, templateList] = await Promise.all([
    db('offset_field_catalog')
      .select('field_name', 'kind', 'criticality', 'base_value')
      .orderBy('field_name', 'asc'),
    db('server_offset_overrides')
      .where('server_id', serverId)
      .select('field_name', 'value'),
    templateId != null
      ? db('template_field_values').where('template_id', templateId).select('field_name', 'value')
      : Promise.resolve([]),
    db('build_templates').select('id', 'name').orderBy('name', 'asc'),
  ]);

  // BIGINT columns arrive as strings from mysql2; normalize to Number for the
  // JSON response (offsets are well within Number's safe integer range).
  const num = (v) => (v == null ? null : Number(v));

  const overrideByName = new Map(overrideRows.map(r => [r.field_name, num(r.value)]));
  const templateByName = new Map(templateValueRows.map(r => [r.field_name, num(r.value)]));

  // Base for a field = the server's template value, else the catalog's compiled
  // fallback (base_value). Effective = the override, else the base.
  const catalog = catalogRows.map(r => {
    const base = templateByName.has(r.field_name) ? templateByName.get(r.field_name) : num(r.base_value);
    return { field_name: r.field_name, kind: r.kind, criticality: r.criticality, base_value: base };
  });
  const overrides = catalog
    .filter(c => overrideByName.has(c.field_name))
    .map(c => ({ field_name: c.field_name, value: overrideByName.get(c.field_name) }));
  const effective = catalog.map(c => ({
    field_name: c.field_name,
    base_value: c.base_value,
    override:   overrideByName.has(c.field_name) ? overrideByName.get(c.field_name) : null,
  }));

  res.json({
    fingerprint: {
      stamp: num(server.engine_time_date_stamp),
      size:  num(server.engine_size_of_image),
    },
    template_id: templateId,
    templates:   templateList.map(t => ({ id: Number(t.id), name: t.name })),
    catalog,
    overrides,
    effective,
    signed:    !!server.offset_signed_blob,
    signed_at: num(server.offset_signed_at),
  });
});

// ── PUT /servers/:id/offsets ─────────────────────────────────────────────────
// Set the engine fingerprint (stamp/size, when supplied) + REPLACE this server's
// overrides. EVERY field_name must exist in offset_field_catalog (400 else).
// Editing the content INVALIDATES the signed blob (cleared) — the admin must
// re-sign after any change. Responds { ok, count }.
router.put('/servers/:id/offsets', requireSuperAdmin, validate(offsetsPutSchema), async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serverId) || serverId < 0) {
    return res.status(400).json({ error: 'Bad server id' });
  }

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { stamp, size, overrides, offset_template_id } = req.validated;

  // Validate the chosen template exists (when a non-null id is supplied).
  if (offset_template_id != null) {
    const tpl = await db('build_templates').where('id', offset_template_id).select('id').first();
    if (!tpl) return res.status(400).json({ error: 'Unknown template' });
  }

  // Reject duplicate field_names in the payload (an override PK is
  // (server_id, field_name); a dupe would make the "replace" ambiguous).
  const seen = new Set();
  for (const o of overrides) {
    if (seen.has(o.field_name)) {
      return res.status(400).json({ error: `Duplicate field_name: ${o.field_name}` });
    }
    seen.add(o.field_name);
  }

  // Validate every field_name against the catalog (400 on ANY unknown field).
  if (overrides.length) {
    const names = [...seen];
    const known = await db('offset_field_catalog')
      .whereIn('field_name', names)
      .pluck('field_name');
    const knownSet = new Set(known);
    const unknown = names.filter(n => !knownSet.has(n));
    if (unknown.length) {
      return res.status(400).json({ error: 'Unknown field_name(s)', fields: unknown });
    }
  }

  const now = nowSec();
  await db.transaction(async (trx) => {
    // Fingerprint (only the supplied dimensions; leave the other untouched).
    const patch = {};
    if (stamp !== undefined) patch.engine_time_date_stamp = stamp;
    if (size  !== undefined) patch.engine_size_of_image   = size;
    // offset_template_id: undefined = leave, null = clear, id = set.
    if (offset_template_id !== undefined) patch.offset_template_id = offset_template_id;
    // Content changed → INVALIDATE the signed blob (must be re-signed).
    patch.offset_signed_blob = null;
    patch.offset_signed_at   = null;
    await trx('game_servers').where('id', serverId).update(patch);

    // REPLACE-ALL the overrides for this server.
    await trx('server_offset_overrides').where('server_id', serverId).del();
    if (overrides.length) {
      await trx('server_offset_overrides').insert(
        overrides.map(o => ({
          server_id:  serverId,
          field_name: o.field_name,
          value:      o.value,
          updated_at: now,
        })),
      );
    }
  });

  await recordAudit(db, req, {
    action: 'world.offset.set', subjectType: 'game_server', subjectId: String(serverId),
    newValues: {
      stamp: stamp !== undefined ? stamp : null,
      size:  size  !== undefined ? size  : null,
      override_count: overrides.length,
      invalidated_blob: true,
    },
  });

  res.json({ ok: true, count: overrides.length });
});

// ── POST /servers/:id/offsets/sign ───────────────────────────────────────────
// Sign the server's current fingerprint + overrides into a blob with the signing
// key + the supplied password. 409 if no signing key exists; 400 if the
// fingerprint (stamp/size) is unset; 403 on a WRONG password (typed AuthError,
// no leak). Stores JSON.stringify({payload_b64,signature_b64}) + signed_at.
router.post('/servers/:id/offsets/sign', requireSuperAdmin, validate(offsetSignSchema), async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serverId) || serverId < 0) {
    return res.status(400).json({ error: 'Bad server id' });
  }
  const { password } = req.validated;

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const keyRow = await db('offset_signing_keys').where('id', KEY_ROW_ID).first();
  if (!keyRow) {
    return res.status(409).json({ error: 'generate a signing key first' });
  }

  // The fingerprint is REQUIRED to sign — the blob is keyed to a specific
  // Engine.dll build so a bot never applies it to the wrong binary.
  if (server.engine_time_date_stamp == null || server.engine_size_of_image == null) {
    return res.status(400).json({ error: 'set the engine fingerprint (stamp/size) before signing' });
  }
  const stamp = Number(server.engine_time_date_stamp);
  const size  = Number(server.engine_size_of_image);

  // The blob carries the FULL EFFECTIVE offset set = the server's build-template
  // base MERGED WITH its overrides (override wins). This makes the panel
  // authoritative: the bot applies every field it's given (fields the panel doesn't
  // manage — no template value, no override — are simply absent and keep the bot's
  // compiled value). BIGINT values arrive as strings from mysql2.
  const [templateValueRows, overrideRows] = await Promise.all([
    server.offset_template_id != null
      ? db('template_field_values').where('template_id', Number(server.offset_template_id)).select('field_name', 'value')
      : Promise.resolve([]),
    db('server_offset_overrides').where('server_id', serverId).select('field_name', 'value'),
  ]);
  const fields = {};
  for (const r of templateValueRows) fields[r.field_name] = Number(r.value);   // base
  for (const r of overrideRows)      fields[r.field_name] = Number(r.value);   // override wins
  const fieldCount = Object.keys(fields).length;

  let blob;
  try {
    blob = await buildBlob(serverId, stamp, size, fields, password, keyRow.enc_private_key);
  } catch (err) {
    if (err instanceof OffsetKeyAuthError) {
      return res.status(403).json({ error: 'wrong signing password' });
    }
    throw err;
  }

  const now = nowSec();
  await db('game_servers').where('id', serverId).update({
    offset_signed_blob: JSON.stringify(blob),
    offset_signed_at:   now,
  });

  // Audit the signing event — NEVER the password.
  await recordAudit(db, req, {
    action: 'world.offset.sign', subjectType: 'game_server', subjectId: String(serverId),
    newValues: { field_count: fieldCount, signed_at: now },
  });

  res.json({ ok: true, signed_at: now });
});

// ─────────────────────────────────────────────────────────────────────────────
// Build templates (Phase 1) — named per-edition base value-sets that servers fork.
// ─────────────────────────────────────────────────────────────────────────────

// GET /offset-templates — list with per-template field + server-usage counts.
router.get('/offset-templates', requireSuperAdmin, async (req, res) => {
  const [templates, fieldCounts, serverCounts] = await Promise.all([
    db('build_templates').select('id', 'name', 'notes', 'created_at', 'updated_at').orderBy('name', 'asc'),
    db('template_field_values').select('template_id').count({ c: '*' }).groupBy('template_id'),
    db('game_servers').whereNotNull('offset_template_id').select('offset_template_id').count({ c: '*' }).groupBy('offset_template_id'),
  ]);
  const fc = new Map(fieldCounts.map(r => [Number(r.template_id), Number(r.c)]));
  const sc = new Map(serverCounts.map(r => [Number(r.offset_template_id), Number(r.c)]));
  res.json(templates.map(t => ({
    id: Number(t.id), name: t.name, notes: t.notes,
    field_count: fc.get(Number(t.id)) || 0,
    servers_using: sc.get(Number(t.id)) || 0,
    created_at: Number(t.created_at), updated_at: Number(t.updated_at),
  })));
});

// GET /offset-templates/:id — the template + its per-field values joined against
// the catalog (so the editor can list every field, value null = uses no base).
router.get('/offset-templates/:id', requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 0) return res.status(400).json({ error: 'Bad template id' });
  const tpl = await db('build_templates').where('id', id).first();
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const [catalogRows, valueRows] = await Promise.all([
    db('offset_field_catalog').select('field_name', 'kind', 'criticality').orderBy('field_name', 'asc'),
    db('template_field_values').where('template_id', id).select('field_name', 'value'),
  ]);
  const num = (v) => (v == null ? null : Number(v));
  const valByName = new Map(valueRows.map(r => [r.field_name, num(r.value)]));
  res.json({
    id: Number(tpl.id), name: tpl.name, notes: tpl.notes,
    fields: catalogRows.map(c => ({
      field_name: c.field_name, kind: c.kind, criticality: c.criticality,
      value: valByName.has(c.field_name) ? valByName.get(c.field_name) : null,
    })),
  });
});

// POST /offset-templates — create an empty template (409 on dup name).
router.post('/offset-templates', requireSuperAdmin, validate(templateCreateSchema), async (req, res) => {
  const { name, notes } = req.validated;
  const trimmed = name.trim();
  if (!trimmed) return res.status(422).json({ error: 'name is required' });
  const dup = await db('build_templates').where('name', trimmed).select('id').first();
  if (dup) return res.status(409).json({ error: 'A template with that name already exists' });
  const now = nowSec();
  const [id] = await db('build_templates').insert({
    name: trimmed, notes: notes ?? null, created_at: now, updated_at: now,
  });
  await recordAudit(db, req, {
    action: 'world.template.create', subjectType: 'build_template', subjectId: String(id),
    newValues: { name: trimmed },
  });
  res.status(201).json({ id: Number(id), name: trimmed });
});

// PATCH /offset-templates/:id — rename / edit notes (409 on dup name).
router.patch('/offset-templates/:id', requireSuperAdmin, validate(templateUpdateSchema), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 0) return res.status(400).json({ error: 'Bad template id' });
  const tpl = await db('build_templates').where('id', id).first();
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const { name, notes } = req.validated;
  const patch = { updated_at: nowSec() };
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) return res.status(422).json({ error: 'name cannot be empty' });
    const dup = await db('build_templates').where('name', trimmed).whereNot('id', id).select('id').first();
    if (dup) return res.status(409).json({ error: 'A template with that name already exists' });
    patch.name = trimmed;
  }
  if (notes !== undefined) patch.notes = notes;
  await db('build_templates').where('id', id).update(patch);
  await recordAudit(db, req, {
    action: 'world.template.update', subjectType: 'build_template', subjectId: String(id),
    newValues: { name: patch.name ?? tpl.name },
  });
  res.json({ ok: true });
});

// DELETE /offset-templates/:id — remove it + its values, and unlink any servers
// that forked it (they fall back to the catalog base until re-pointed).
router.delete('/offset-templates/:id', requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 0) return res.status(400).json({ error: 'Bad template id' });
  const tpl = await db('build_templates').where('id', id).select('id', 'name').first();
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  await db.transaction(async (trx) => {
    // Servers that forked this template lose their base + must re-sign.
    await trx('game_servers').where('offset_template_id', id)
      .update({ offset_template_id: null, offset_signed_blob: null, offset_signed_at: null });
    await trx('template_field_values').where('template_id', id).del();
    await trx('build_templates').where('id', id).del();
  });
  await recordAudit(db, req, {
    action: 'world.template.delete', subjectType: 'build_template', subjectId: String(id),
    oldValues: { name: tpl.name },
  });
  res.json({ ok: true });
});

// PUT /offset-templates/:id/values — REPLACE-ALL the template's base field values
// (the editor's save). Validates names against the catalog. Invalidates the signed
// blob of every server forking this template (their base just changed → re-sign).
router.put('/offset-templates/:id/values', requireSuperAdmin, validate(templateValuesPutSchema), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 0) return res.status(400).json({ error: 'Bad template id' });
  const tpl = await db('build_templates').where('id', id).select('id').first();
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const { values } = req.validated;

  const seen = new Set();
  for (const v of values) {
    if (seen.has(v.field_name)) return res.status(400).json({ error: `Duplicate field_name: ${v.field_name}` });
    seen.add(v.field_name);
  }
  if (values.length) {
    const known = await db('offset_field_catalog').whereIn('field_name', [...seen]).pluck('field_name');
    const knownSet = new Set(known);
    const unknown = [...seen].filter(n => !knownSet.has(n));
    if (unknown.length) return res.status(400).json({ error: 'Unknown field_name(s)', fields: unknown });
  }

  const now = nowSec();
  await db.transaction(async (trx) => {
    await trx('template_field_values').where('template_id', id).del();
    if (values.length) {
      await trx('template_field_values').insert(
        values.map(v => ({ template_id: id, field_name: v.field_name, value: v.value })),
      );
    }
    await trx('build_templates').where('id', id).update({ updated_at: now });
    // Base changed → servers forking this template must re-sign.
    await trx('game_servers').where('offset_template_id', id)
      .update({ offset_signed_blob: null, offset_signed_at: null });
  });
  await recordAudit(db, req, {
    action: 'world.template.set_values', subjectType: 'build_template', subjectId: String(id),
    newValues: { count: values.length },
  });
  res.json({ ok: true, count: values.length });
});

export default router;
