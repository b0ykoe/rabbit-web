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
         templateCreateSchema, templateUpdateSchema, templateValuesPutSchema,
         buildCreateSchema, buildUpdateSchema, buildOverridesPutSchema,
         buildSignSchema, buildsSignAllSchema } from '../validation/schemas.js';
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
  const byName = new Map();          // field_name -> catalog row (name/kind/crit/base[/base_text])
  const activeByName = new Map();    // field_name -> ACTIVE value (running variant, numeric)
  const activeTextByName = new Map();// field_name -> ACTIVE mangled name (running variant, name slots)
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const rawName = (typeof e.field_name === 'string' && e.field_name) ? e.field_name
      : (typeof e.name === 'string' ? e.name : '');
    const fieldName = rawName.trim();
    if (fieldName.length < 1 || fieldName.length > 64) continue;
    const kind = typeof e.kind === 'string' ? e.kind.trim().toLowerCase() : '';
    if (kind !== 'data' && kind !== 'va' && kind !== 'name') continue;

    let criticality = null;
    if (e.criticality != null) {
      const c = String(e.criticality).trim();
      if (c) criticality = c.slice(0, 16);
    }

    if (kind === 'name') {
      // NAME slot (P5, STRING dimension): the Stock base is a mangled Engine.dll
      // export name string, not a number. base_value stays null; base_text holds
      // the string (explicit base_text, else the exporter's base_default /
      // name_default, else a string `value`). Cap the stored string at 255.
      const rawBaseText =
        (typeof e.base_text === 'string' && e.base_text) ? e.base_text
        : (typeof e.base_default === 'string' && e.base_default) ? e.base_default
        : (typeof e.name_default === 'string' && e.name_default) ? e.name_default
        : (typeof e.value === 'string' && e.value) ? e.value
        : null;
      const baseText = rawBaseText != null ? String(rawBaseText).slice(0, 255) : null;

      // ACTIVE mangled name on the exporting machine (running variant, e.g.
      // Nemesis) — used below to auto-derive that server's name override = slots
      // whose active string differs from the Stock base. Falls back to the base.
      const rawActiveText = (typeof e.value === 'string' && e.value) ? e.value : rawBaseText;
      if (rawActiveText != null) activeTextByName.set(fieldName, String(rawActiveText).slice(0, 255));

      byName.set(fieldName, {
        field_name: fieldName,
        kind,
        criticality,
        base_value: null,
        base_text:  baseText,
        updated_at: now,
      });
      if (byName.size >= CATALOG_CAP) break;
      continue;
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
      base_text:  null,
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
    // Numeric slots seed value=base_value; NAME slots (P5) seed value_text=base_text
    // (parallel). A template row exists for a slot that has EITHER a numeric base OR
    // a base name string. `value` is NOT NULL in the schema, so a name-only row
    // stores value=0 as a placeholder (its string lives in value_text).
    const tplRows = rows
      .filter(r => r.base_value != null || (r.kind === 'name' && r.base_text != null))
      .map(r => (r.kind === 'name'
        ? { template_id: templateId, field_name: r.field_name, value: 0, value_text: r.base_text }
        : { template_id: templateId, field_name: r.field_name, value: r.base_value, value_text: null }));
    if (tplRows.length) await trx('template_field_values').insert(tplRows);

    // 3) Auto-derive the exporting server's overrides = fields whose ACTIVE value
    //    differs from the Stock base. Points the server at this template, REPLACE-ALL
    //    its overrides, and clears any stale signed blob (content changed).
    if (targetServerId > 0) {
      const srv = await trx('game_servers').where('id', targetServerId).select('id').first();
      if (srv) {
        const overrideRows = [];
        for (const r of rows) {
          if (r.kind === 'name') {
            // NAME slot (P5): auto-derive the string override = slots whose ACTIVE
            // mangled name differs from the Stock base_text. value is NOT NULL in
            // the schema, so store value=0 as a placeholder — the string lives in
            // value_text (parallel to the numeric value auto-derive below).
            const at = activeTextByName.get(r.field_name);
            if (at == null || at === r.base_text) continue;   // no delta
            overrideRows.push({ server_id: targetServerId, field_name: r.field_name, value: 0, value_text: at, updated_at: now });
            continue;
          }
          if (r.base_value == null) continue;
          const av = activeByName.get(r.field_name);
          if (av == null || av === r.base_value) continue;   // no delta
          overrideRows.push({ server_id: targetServerId, field_name: r.field_name, value: av, value_text: null, updated_at: now });
        }
        // Also stamp the server's Engine.dll FINGERPRINT from the export (the bot
        // records the stamp/size of the binary it read), so the admin doesn't have
        // to type it by hand before signing.
        const srvPatch = {
          offset_template_id: templateId,
          offset_signed_blob: null,
          offset_signed_at:   null,
        };
        const impStamp = Number(parsed?.stamp);
        const impSize  = Number(parsed?.size);
        if (Number.isInteger(impStamp) && impStamp >= 0) srvPatch.engine_time_date_stamp = impStamp;
        if (Number.isInteger(impSize)  && impSize  >= 0) srvPatch.engine_size_of_image   = impSize;
        await trx('game_servers').where('id', targetServerId).update(srvPatch);
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
    // Numeric override editor only — name-slots (kind='name') are managed via the
    // catalog import + auto-derive, not the per-field numeric table (P5).
    db('offset_field_catalog')
      .whereNot('kind', 'name')
      .select('field_name', 'kind', 'criticality', 'base_value', 'base_text')
      .orderBy('field_name', 'asc'),
    db('server_offset_overrides')
      .where('server_id', serverId)
      .select('field_name', 'value', 'value_text'),
    templateId != null
      ? db('template_field_values').where('template_id', templateId).select('field_name', 'value', 'value_text')
      : Promise.resolve([]),
    db('build_templates').select('id', 'name').orderBy('name', 'asc'),
  ]);

  // BIGINT columns arrive as strings from mysql2; normalize to Number for the
  // JSON response (offsets are well within Number's safe integer range).
  const num = (v) => (v == null ? null : Number(v));

  const overrideByName = new Map(overrideRows.map(r => [r.field_name, num(r.value)]));
  const templateByName = new Map(templateValueRows.map(r => [r.field_name, num(r.value)]));
  // STRING dimension (P5) — parallel maps of effective mangled names. value_text is
  // NULL for numeric slots, so these only carry name-slot strings.
  const overrideTextByName = new Map(overrideRows.filter(r => r.value_text != null).map(r => [r.field_name, r.value_text]));
  const templateTextByName = new Map(templateValueRows.filter(r => r.value_text != null).map(r => [r.field_name, r.value_text]));

  // Base for a field = the server's template value, else the catalog's compiled
  // fallback (base_value). Effective = the override, else the base. NAME slots (P5)
  // carry a parallel `text` (base name = template.value_text ?? catalog.base_text)
  // alongside numeric `base_value` (which is null for a name slot).
  const catalog = catalogRows.map(r => {
    const base = templateByName.has(r.field_name) ? templateByName.get(r.field_name) : num(r.base_value);
    const text = r.kind === 'name'
      ? (templateTextByName.has(r.field_name) ? templateTextByName.get(r.field_name) : (r.base_text ?? null))
      : null;
    return { field_name: r.field_name, kind: r.kind, criticality: r.criticality, base_value: base, text };
  });
  const overrides = catalog
    .filter(c => overrideByName.has(c.field_name) || overrideTextByName.has(c.field_name))
    .map(c => ({
      field_name: c.field_name,
      value:      overrideByName.has(c.field_name) ? overrideByName.get(c.field_name) : null,
      text:       c.kind === 'name' && overrideTextByName.has(c.field_name) ? overrideTextByName.get(c.field_name) : null,
    }));
  const effective = catalog.map(c => ({
    field_name: c.field_name,
    base_value: c.base_value,
    text:       c.kind === 'name'
      ? (overrideTextByName.has(c.field_name) ? overrideTextByName.get(c.field_name) : c.text)
      : null,
    override:   overrideByName.has(c.field_name) ? overrideByName.get(c.field_name) : null,
  }));

  // Is the stored server-level base blob OUT OF DATE vs the current effective set?
  // (overrides/label/template changed, or it predates a payload-format change) → the
  // admin must re-sign. Only meaningful once signed.
  const baseStale = server.offset_signed_blob
    ? signedBlobStale(server.offset_signed_blob, await baseEffectiveContent(server, serverId))
    : false;

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
    stale:     baseStale,
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

    // REPLACE-ALL the overrides for this server. value = numeric override (0
    // placeholder when only a name override is supplied — `value` is NOT NULL);
    // value_text = the mangled name override for a kind:"name" slot (P5), else null.
    await trx('server_offset_overrides').where('server_id', serverId).del();
    if (overrides.length) {
      await trx('server_offset_overrides').insert(
        overrides.map(o => ({
          server_id:  serverId,
          field_name: o.field_name,
          value:      o.value != null ? o.value : 0,
          value_text: o.value_text != null ? o.value_text : null,
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

  // The server base is IDENTITY-gated (the bot applies it for ANY build of this
  // server), so the fingerprint is OPTIONAL — it's only the reference build stamped
  // into the payload for the bot's diagnostics. Default 0 when unset; the bot ignores
  // stamp/size for a base blob. (Per-build blobs keep their exact-stamp gate.)
  // The server-level BASE content: effective DATA offsets (kind='va' STRIPPED — this
  // blob is IDENTITY-gated on the bot and must not carry per-build VAs) + names
  // (GetProcAddress-by-string, build-independent + fail-safe). Fingerprint is optional
  // (reference only). Same content the staleness check uses, so they can't drift.
  const c = await baseEffectiveContent(server, serverId);
  const fieldCount = Object.keys(c.fields).length;

  let blob;
  try {
    // isBase=true → the bot applies this on server identity, not the exact fingerprint.
    blob = await buildBlob(serverId, c.stamp, c.size, c.fields, c.names, password, keyRow.enc_private_key, null, true);
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

// ── GET /servers/:id/offset-dev-file ─────────────────────────────────────────
// Emit the UNSIGNED effective profile as a bot-ingestible offset_overrides.json a
// dev machine can drop into %APPDATA%/<DATA_DIR_NAME>/ to bootstrap. Same EFFECTIVE
// merge as the sign handler (build-template base MERGED WITH overrides, override
// wins) but NO signing, NO password — the Debug bot reads this file directly. 404
// if the server is missing. stamp/size may be null on a dev box (that is fine).
router.get('/servers/:id/offset-dev-file', requireSuperAdmin, async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serverId) || serverId < 0) {
    return res.status(400).json({ error: 'Bad server id' });
  }

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) return res.status(404).json({ error: 'Server not found' });

  // Effective offset set = the server's build-template base MERGED WITH its
  // overrides (override wins) — the exact merge the sign handler blob carries.
  // BIGINT values arrive as strings from mysql2.
  const [templateValueRows, overrideRows] = await Promise.all([
    server.offset_template_id != null
      ? db('template_field_values').where('template_id', Number(server.offset_template_id)).whereNull('value_text').select('field_name', 'value')
      : Promise.resolve([]),
    db('server_offset_overrides').where('server_id', serverId).whereNull('value_text').select('field_name', 'value'),
  ]);
  const fields = {};
  for (const r of templateValueRows) fields[r.field_name] = Number(r.value);   // base
  for (const r of overrideRows)      fields[r.field_name] = Number(r.value);   // override wins

  res.json({
    v: 1,
    server_id: serverId,
    // null only when unset (mirror the sign handler, which permits 0 and rejects
    // only null — `Number(x) || null` would wrongly null a legitimate 0).
    stamp: server.engine_time_date_stamp == null ? null : Number(server.engine_time_date_stamp),
    size:  server.engine_size_of_image   == null ? null : Number(server.engine_size_of_image),
    fields,
  });
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
    // Numeric editor only — name-slots (kind='name') carry strings, not offsets.
    db('offset_field_catalog').whereNot('kind', 'name').select('field_name', 'kind', 'criticality').orderBy('field_name', 'asc'),
    db('template_field_values').where('template_id', id).whereNull('value_text').select('field_name', 'value'),
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-server builds (Phase P4) — a PER-BUILD (per Engine.dll stamp) override layer
// + per-build signed blobs, keyed PER-SERVER + stamp. Mirrors the bot's
// engine_variant_nemesis.cpp: general constructor (server_offset_overrides) + a
// per-stamp ApplyBuildSpecificOverrides switch (server_build_overrides). Effective
// value for a bot on (server, stamp) = per_build ?? general ?? template base.
// ─────────────────────────────────────────────────────────────────────────────

// Read the GENERAL effective set for a server = template base MERGED WITH the
// server's overrides (override wins). This is the EXACT template+general merge the
// sign handler / GET /servers/:id/offsets use — reused so a build's `effective`
// shows the inherited value as base and its per-build value as the override.
// BIGINT values arrive as strings from mysql2 → Number. Returns { [field]: int }.
async function generalEffectiveFields(server, serverId) {
  const [templateValueRows, overrideRows] = await Promise.all([
    server.offset_template_id != null
      ? db('template_field_values').where('template_id', Number(server.offset_template_id)).whereNull('value_text').select('field_name', 'value')
      : Promise.resolve([]),
    db('server_offset_overrides').where('server_id', serverId).whereNull('value_text').select('field_name', 'value'),
  ]);
  const fields = {};
  for (const r of templateValueRows) fields[r.field_name] = Number(r.value);   // base
  for (const r of overrideRows)      fields[r.field_name] = Number(r.value);   // override wins
  return fields;
}

// The SERVER-LEVEL "base" effective set = generalEffectiveFields with every
// kind='va' field REMOVED. The base blob is applied IDENTITY-gated on the bot (not
// fingerprint-gated), so it must carry ONLY layout-stable DATA offsets — absolute
// VAs shift per Engine build and belong exclusively to the exact-stamp per-build
// blobs (signOneBuild keeps them; this strips them). Per-build signing uses
// generalEffectiveFields directly (VAs intact) — only the server-level base uses this.
async function baseEffectiveFields(server, serverId) {
  const fields = await generalEffectiveFields(server, serverId);
  const vaNames = await db('offset_field_catalog').where('kind', 'va').pluck('field_name');
  for (const k of vaNames) delete fields[k];
  return fields;
}

// The effective PAYLOAD CONTENT ({stamp,size,fields,names,label,base}) a per-build
// blob would be signed with — WITHOUT signing. signOneBuild + the staleness check
// both go through this so the "needs re-sign?" signal can never drift from what a
// real sign produces.
async function buildEffectiveContent(server, serverId, build) {
  const general = await generalEffectiveFields(server, serverId);   // template + general (VAs kept)
  const buildOverrideRows = await db('server_build_overrides')
    .where('server_build_id', build.id).whereNull('value_text').select('field_name', 'value');
  const fields = { ...general };
  for (const r of buildOverrideRows) fields[r.field_name] = Number(r.value);   // per-build wins
  const names = await effectiveNames(serverId, build.id);
  return {
    stamp: Number(build.stamp), size: Number(build.size),
    fields, names, label: build.label || '', base: false,
  };
}

// The effective PAYLOAD CONTENT for the server-level identity-gated base (DATA only,
// VAs stripped; fingerprint optional → 0). Used by the base sign paths + staleness.
async function baseEffectiveContent(server, serverId) {
  const fields = await baseEffectiveFields(server, serverId);
  const names  = await effectiveNames(serverId);
  return {
    stamp: server.engine_time_date_stamp == null ? 0 : Number(server.engine_time_date_stamp),
    size:  server.engine_size_of_image  == null ? 0 : Number(server.engine_size_of_image),
    fields, names, label: '', base: true,
  };
}

// True when a STORED signed blob no longer matches what a fresh sign would produce
// (`content` from *EffectiveContent above) → the admin must re-sign. Compares the
// meaningful payload dimensions (fields + names as maps, label, base flag), order-
// independent. A null stored blob is "unsigned" (NOT stale — a distinct state). An
// unparseable stored blob is treated as stale (re-sign to heal it).
function signedBlobStale(storedText, content) {
  if (storedText == null) return false;
  let payload;
  try {
    const outer = JSON.parse(storedText);
    payload = JSON.parse(Buffer.from(String(outer.payload_b64 || ''), 'base64').toString('utf8'));
  } catch { return true; }
  const mapsDiffer = (a, b) => {
    a = a || {}; b = b || {};
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return true;
    for (const k of ak) if (String(a[k]) !== String(b[k])) return true;
    return false;
  };
  if (mapsDiffer(payload.fields, content.fields)) return true;
  if (mapsDiffer(payload.names,  content.names))  return true;
  if ((payload.label || '') !== (content.label || '')) return true;
  if (!!payload.base !== !!content.base) return true;
  // Per-build blobs are EXACT-stamp gated on the bot — a stamp/size change must count
  // as stale (defense-in-depth: no route edits an existing build's stamp/size today).
  // The base is identity-gated (stamp/size reference-only), so skip it there.
  if (!content.base) {
    if (Number(payload.stamp) !== Number(content.stamp)) return true;
    if (Number(payload.size)  !== Number(content.size))  return true;
  }
  return false;
}

// Build the STRING dimension (P5) — the effective mangled Engine.dll export names
// for a server (and optionally a build). For every kind:"name" catalog slot the
// effective name = build.value_text ?? general.value_text ?? template.value_text ??
// catalog.base_text (slots with no effective name are SKIPPED — they never enter
// the signed `names`). Precedence mirrors generalEffectiveFields exactly, one layer
// per table. Pass a buildId to fold that build's per-build name override on top;
// omit it for the server-level blob. Returns { [slot]: mangledName }.
async function effectiveNames(serverId, buildId) {
  const server = await db('game_servers').where('id', serverId).select('offset_template_id').first();
  const templateId = server && server.offset_template_id != null ? Number(server.offset_template_id) : null;

  const [catalogRows, templateRows, generalRows, buildRows] = await Promise.all([
    db('offset_field_catalog').where('kind', 'name').select('field_name', 'base_text'),
    templateId != null
      ? db('template_field_values').where('template_id', templateId).select('field_name', 'value_text')
      : Promise.resolve([]),
    db('server_offset_overrides').where('server_id', serverId).select('field_name', 'value_text'),
    buildId != null
      ? db('server_build_overrides').where('server_build_id', buildId).select('field_name', 'value_text')
      : Promise.resolve([]),
  ]);

  const templateByName = new Map(templateRows.filter(r => r.value_text != null).map(r => [r.field_name, r.value_text]));
  const generalByName  = new Map(generalRows.filter(r => r.value_text != null).map(r => [r.field_name, r.value_text]));
  const buildByName    = new Map(buildRows.filter(r => r.value_text != null).map(r => [r.field_name, r.value_text]));

  const names = {};
  for (const r of catalogRows) {
    const eff = buildByName.has(r.field_name)    ? buildByName.get(r.field_name)
      : generalByName.has(r.field_name)          ? generalByName.get(r.field_name)
      : templateByName.has(r.field_name)         ? templateByName.get(r.field_name)
      : (r.base_text != null ? r.base_text : null);
    if (eff != null) names[r.field_name] = eff;   // skip slots with no effective name
  }
  return names;
}

// ── GET /servers/:id/builds ──────────────────────────────────────────────────
// List a server's builds with a per-build override count + signed status. 404 if
// the server is missing.
router.get('/servers/:id/builds', requireSuperAdmin, async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serverId) || serverId < 0) {
    return res.status(400).json({ error: 'Bad server id' });
  }
  // offset_template_id is needed to recompute each build's effective content for the
  // staleness check (generalEffectiveFields reads it).
  const server = await db('game_servers').where('id', serverId).select('id', 'offset_template_id').first();
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const builds = await db('server_builds')
    .where('server_id', serverId)
    .select('id', 'stamp', 'size', 'label', 'signed_blob', 'signed_at')
    .orderBy('stamp', 'asc');

  const counts = builds.length
    ? await db('server_build_overrides')
        .whereIn('server_build_id', builds.map(b => b.id))
        .select('server_build_id').count({ c: '*' }).groupBy('server_build_id')
    : [];
  const cc = new Map(counts.map(r => [Number(r.server_build_id), Number(r.c)]));
  const num = (v) => (v == null ? null : Number(v));

  // Staleness per SIGNED build: does the stored blob still match a fresh sign?
  // (unsigned builds are skipped → not stale). Recomputed via the SAME content path
  // signOneBuild uses, so the signal can't drift.
  const staleById = new Map();
  await Promise.all(
    builds.filter(b => b.signed_blob != null).map(async (b) => {
      const content = await buildEffectiveContent(server, serverId, b);
      staleById.set(Number(b.id), signedBlobStale(b.signed_blob, content));
    }),
  );

  res.json(builds.map(b => ({
    id:             Number(b.id),
    stamp:          num(b.stamp),
    size:           num(b.size),
    label:          b.label,
    override_count: cc.get(Number(b.id)) || 0,
    signed:         !!b.signed_blob,
    signed_at:      num(b.signed_at),
    stale:          staleById.get(Number(b.id)) || false,
  })));
});

// ── POST /servers/:id/builds ─────────────────────────────────────────────────
// Create a build (server, stamp). 409 on a duplicate (server_id, stamp).
router.post('/servers/:id/builds', requireSuperAdmin, validate(buildCreateSchema), async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serverId) || serverId < 0) {
    return res.status(400).json({ error: 'Bad server id' });
  }
  const server = await db('game_servers').where('id', serverId).select('id').first();
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { stamp, size, label } = req.validated;

  const dup = await db('server_builds').where({ server_id: serverId, stamp }).select('id').first();
  if (dup) return res.status(409).json({ error: 'A build with that stamp already exists' });

  const now = nowSec();
  const [id] = await db('server_builds').insert({
    server_id: serverId, stamp, size, label: label ?? null,
    signed_blob: null, signed_at: null, created_at: now, updated_at: now,
  });

  await recordAudit(db, req, {
    action: 'world.build.create', subjectType: 'server_build', subjectId: String(id),
    newValues: { server_id: serverId, stamp, size, label: label ?? null },
  });

  res.status(201).json({ id: Number(id), stamp, size, label: label ?? null });
});

// ── PATCH /servers/:id/builds/:bid ───────────────────────────────────────────
// Edit the build's label (null clears it).
router.patch('/servers/:id/builds/:bid', requireSuperAdmin, validate(buildUpdateSchema), async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  const buildId  = parseInt(req.params.bid, 10);
  if (!Number.isFinite(serverId) || serverId < 0) return res.status(400).json({ error: 'Bad server id' });
  if (!Number.isFinite(buildId)  || buildId  < 0) return res.status(400).json({ error: 'Bad build id' });

  const build = await db('server_builds').where({ id: buildId, server_id: serverId }).first();
  if (!build) return res.status(404).json({ error: 'Build not found' });

  const { label } = req.validated;
  const patch = { updated_at: nowSec() };
  if (label !== undefined) patch.label = label;
  await db('server_builds').where('id', buildId).update(patch);

  await recordAudit(db, req, {
    action: 'world.build.update', subjectType: 'server_build', subjectId: String(buildId),
    newValues: { label: label !== undefined ? label : build.label },
  });
  res.json({ ok: true });
});

// ── DELETE /servers/:id/builds/:bid ──────────────────────────────────────────
// Remove a build + its per-build overrides.
router.delete('/servers/:id/builds/:bid', requireSuperAdmin, async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  const buildId  = parseInt(req.params.bid, 10);
  if (!Number.isFinite(serverId) || serverId < 0) return res.status(400).json({ error: 'Bad server id' });
  if (!Number.isFinite(buildId)  || buildId  < 0) return res.status(400).json({ error: 'Bad build id' });

  const build = await db('server_builds').where({ id: buildId, server_id: serverId }).select('id', 'stamp').first();
  if (!build) return res.status(404).json({ error: 'Build not found' });

  await db.transaction(async (trx) => {
    await trx('server_build_overrides').where('server_build_id', buildId).del();
    await trx('server_builds').where('id', buildId).del();
  });

  await recordAudit(db, req, {
    action: 'world.build.delete', subjectType: 'server_build', subjectId: String(buildId),
    oldValues: { server_id: serverId, stamp: Number(build.stamp) },
  });
  res.json({ ok: true });
});

// ── GET /servers/:id/builds/:bid/offsets ─────────────────────────────────────
// The per-build offset editor view: the build's stamp/size/label, the full
// catalog, this build's per-build overrides, and an EFFECTIVE join where the BASE
// = the GENERAL effective (template base MERGED WITH the server's general
// overrides — the inherited value) and the OVERRIDE = this build's per-build value.
// 404 if the server or build is missing.
router.get('/servers/:id/builds/:bid/offsets', requireSuperAdmin, async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  const buildId  = parseInt(req.params.bid, 10);
  if (!Number.isFinite(serverId) || serverId < 0) return res.status(400).json({ error: 'Bad server id' });
  if (!Number.isFinite(buildId)  || buildId  < 0) return res.status(400).json({ error: 'Bad build id' });

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const build = await db('server_builds').where({ id: buildId, server_id: serverId }).first();
  if (!build) return res.status(404).json({ error: 'Build not found' });

  const [catalogRows, buildOverrideRows, general, generalNames] = await Promise.all([
    // Numeric per-build editor only — name-slots managed via catalog import (P5).
    db('offset_field_catalog')
      .whereNot('kind', 'name')
      .select('field_name', 'kind', 'criticality', 'base_value', 'base_text')
      .orderBy('field_name', 'asc'),
    db('server_build_overrides').where('server_build_id', buildId).whereNull('value_text').select('field_name', 'value', 'value_text'),
    generalEffectiveFields(server, serverId),
    effectiveNames(serverId),   // GENERAL effective names (inherited by this build)
  ]);

  const num = (v) => (v == null ? null : Number(v));
  const buildByName = new Map(buildOverrideRows.map(r => [r.field_name, num(r.value)]));
  // STRING dimension (P5) — this build's per-build name overrides (value_text only).
  const buildTextByName = new Map(buildOverrideRows.filter(r => r.value_text != null).map(r => [r.field_name, r.value_text]));

  // BASE for a field = the GENERAL effective value (template base ± server general
  // override — the inherited value this build sits on top of), else the catalog's
  // compiled fallback. OVERRIDE = the per-build value, else null. NAME slots (P5)
  // carry a parallel `text` (base name = the GENERAL effective name this build
  // inherits) alongside numeric `base_value` (null for a name slot).
  const catalog = catalogRows.map(r => {
    const base = Object.prototype.hasOwnProperty.call(general, r.field_name)
      ? general[r.field_name] : num(r.base_value);
    const text = r.kind === 'name'
      ? (Object.prototype.hasOwnProperty.call(generalNames, r.field_name) ? generalNames[r.field_name] : null)
      : null;
    return { field_name: r.field_name, kind: r.kind, criticality: r.criticality, base_value: base, text };
  });
  const overrides = catalog
    .filter(c => buildByName.has(c.field_name) || buildTextByName.has(c.field_name))
    .map(c => ({
      field_name: c.field_name,
      value:      buildByName.has(c.field_name) ? buildByName.get(c.field_name) : null,
      text:       c.kind === 'name' && buildTextByName.has(c.field_name) ? buildTextByName.get(c.field_name) : null,
    }));
  const effective = catalog.map(c => ({
    field_name: c.field_name,
    base_value: c.base_value,
    text:       c.kind === 'name'
      ? (buildTextByName.has(c.field_name) ? buildTextByName.get(c.field_name) : c.text)
      : null,
    override:   buildByName.has(c.field_name) ? buildByName.get(c.field_name) : null,
  }));

  res.json({
    stamp:     num(build.stamp),
    size:      num(build.size),
    label:     build.label,
    catalog,
    overrides,
    effective,
    signed:    !!build.signed_blob,
    signed_at: num(build.signed_at),
  });
});

// ── PUT /servers/:id/builds/:bid/offsets ─────────────────────────────────────
// REPLACE this build's per-build overrides. EVERY field_name must exist in
// offset_field_catalog (400 else). Editing the content INVALIDATES this build's
// signed blob (cleared) — it must be re-signed. Responds { ok, count }.
router.put('/servers/:id/builds/:bid/offsets', requireSuperAdmin, validate(buildOverridesPutSchema), async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  const buildId  = parseInt(req.params.bid, 10);
  if (!Number.isFinite(serverId) || serverId < 0) return res.status(400).json({ error: 'Bad server id' });
  if (!Number.isFinite(buildId)  || buildId  < 0) return res.status(400).json({ error: 'Bad build id' });

  const server = await db('game_servers').where('id', serverId).select('id').first();
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const build = await db('server_builds').where({ id: buildId, server_id: serverId }).select('id').first();
  if (!build) return res.status(404).json({ error: 'Build not found' });

  const { overrides } = req.validated;

  // Reject duplicate field_names in the payload (the override PK is
  // (server_build_id, field_name); a dupe would make the "replace" ambiguous).
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
    // Content changed → INVALIDATE this build's signed blob (must be re-signed).
    await trx('server_builds').where('id', buildId).update({
      signed_blob: null, signed_at: null, updated_at: now,
    });
    // REPLACE-ALL the per-build overrides. value = numeric override (0 placeholder
    // when only a name override is supplied — `value` is NOT NULL); value_text =
    // the mangled name override for a kind:"name" slot (P5), else null.
    await trx('server_build_overrides').where('server_build_id', buildId).del();
    if (overrides.length) {
      await trx('server_build_overrides').insert(
        overrides.map(o => ({
          server_build_id: buildId,
          field_name:      o.field_name,
          value:           o.value != null ? o.value : 0,
          value_text:      o.value_text != null ? o.value_text : null,
          updated_at:      now,
        })),
      );
    }
  });

  await recordAudit(db, req, {
    action: 'world.build.set', subjectType: 'server_build', subjectId: String(buildId),
    newValues: { override_count: overrides.length, invalidated_blob: true },
  });
  res.json({ ok: true, count: overrides.length });
});

// Sign ONE build in place: fields = merge(template_base, general overrides,
// per-build overrides) with precedence build > general > template; buildBlob with
// the build's OWN stamp/size; store on server_builds.signed_blob/signed_at. Throws
// OffsetKeyAuthError on a wrong password (mapped to 403 by the caller). Returns the
// field count. `server` + `keyRow` are read once by the caller and passed in.
async function signOneBuild(server, serverId, build, password, encPrivateKey) {
  // Same effective content the staleness check uses (no drift). label rides in the
  // payload (display-only); isBase=false keeps VAs + the exact-stamp gate on the bot.
  const c = await buildEffectiveContent(server, serverId, build);
  const blob = await buildBlob(serverId, c.stamp, c.size, c.fields, c.names, password, encPrivateKey, c.label, c.base);

  const now = nowSec();
  await db('server_builds').where('id', build.id).update({
    signed_blob: JSON.stringify(blob), signed_at: now, updated_at: now,
  });
  return { fieldCount: Object.keys(c.fields).length, signed_at: now };
}

// ── POST /servers/:id/builds/:bid/sign ───────────────────────────────────────
// Sign this build's effective set into a blob keyed to the BUILD's stamp/size.
// 409 if no signing key exists; 403 on a WRONG password (typed AuthError, no leak).
router.post('/servers/:id/builds/:bid/sign', requireSuperAdmin, validate(buildSignSchema), async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  const buildId  = parseInt(req.params.bid, 10);
  if (!Number.isFinite(serverId) || serverId < 0) return res.status(400).json({ error: 'Bad server id' });
  if (!Number.isFinite(buildId)  || buildId  < 0) return res.status(400).json({ error: 'Bad build id' });
  const { password } = req.validated;

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const build = await db('server_builds').where({ id: buildId, server_id: serverId }).first();
  if (!build) return res.status(404).json({ error: 'Build not found' });

  const keyRow = await db('offset_signing_keys').where('id', KEY_ROW_ID).first();
  if (!keyRow) {
    return res.status(409).json({ error: 'generate a signing key first' });
  }

  let result;
  try {
    result = await signOneBuild(server, serverId, build, password, keyRow.enc_private_key);
  } catch (err) {
    if (err instanceof OffsetKeyAuthError) {
      return res.status(403).json({ error: 'wrong signing password' });
    }
    throw err;
  }

  await recordAudit(db, req, {
    action: 'world.build.sign', subjectType: 'server_build', subjectId: String(buildId),
    newValues: { field_count: result.fieldCount, signed_at: result.signed_at },
  });
  res.json({ ok: true, signed_at: result.signed_at });
});

// ── POST /servers/:id/builds/sign-all ────────────────────────────────────────
// Re-sign EVERY build of the server AND the server-level blob (038) with ONE
// password. 409 if no signing key exists; 403 on a WRONG password (checked once —
// the same key/password signs every blob). Returns { ok, signed: n } where n is
// the number of blobs written (per-build + the server-level one).
router.post('/servers/:id/builds/sign-all', requireSuperAdmin, validate(buildsSignAllSchema), async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serverId) || serverId < 0) return res.status(400).json({ error: 'Bad server id' });
  const { password } = req.validated;

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const keyRow = await db('offset_signing_keys').where('id', KEY_ROW_ID).first();
  if (!keyRow) {
    return res.status(409).json({ error: 'generate a signing key first' });
  }

  const builds = await db('server_builds').where('server_id', serverId)
    .select('id', 'stamp', 'size', 'label');   // label → signed payload (display-only)

  let signed = 0;
  const now = nowSec();
  try {
    // Per-build blobs.
    for (const build of builds) {
      await signOneBuild(server, serverId, build, password, keyRow.enc_private_key);
      signed += 1;
    }
    // Server-level BASE blob — identity-gated, so ALWAYS (re)signed; the fingerprint
    // is optional (reference build only, default 0). Same merge + crypto as
    // POST /servers/:id/offsets/sign.
    {
      const c = await baseEffectiveContent(server, serverId);   // DATA only (VAs stripped)
      const blob = await buildBlob(
        serverId, c.stamp, c.size, c.fields, c.names, password, keyRow.enc_private_key, null, true,
      );
      await db('game_servers').where('id', serverId).update({
        offset_signed_blob: JSON.stringify(blob), offset_signed_at: now,
      });
      signed += 1;
    }
  } catch (err) {
    if (err instanceof OffsetKeyAuthError) {
      return res.status(403).json({ error: 'wrong signing password' });
    }
    throw err;
  }

  await recordAudit(db, req, {
    action: 'world.build.sign_all', subjectType: 'game_server', subjectId: String(serverId),
    newValues: { signed, builds: builds.length, server_blob: true },
  });
  res.json({ ok: true, signed });
});

export default router;
