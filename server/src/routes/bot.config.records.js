//
// bot.config.records.js
//
// Fact-based config endpoints — generic over identifier type.
// Mounted under /api/bot/config/. All require Bearer user-token via
// validateBotToken; account_id is taken from the token's license.
//
// Endpoints:
//   GET    /record?type=…&a=…&b=…              → { record: {data, updated_at} | null }
//   PUT    /record?type=…&a=…&b=…   {data}     → { ok: true }
//   DELETE /record?type=…&a=…&b=…              → { ok: true }
//   GET    /list?type=…&a=…                    → { records: [{a,b,data,updated_at}] }
//   GET    /active?scope=…                     → { name: string|"" }
//   PUT    /active?scope=…          {name}     → { ok: true }
//   GET    /characters                         → { characters: [string] }
//

import { Router } from 'express';
import { randomBytes } from 'crypto';
import db from '../db.js';
import { validateBotToken } from '../middleware/botToken.js';

const router = Router();

// 'character-profile' is retained in VALID_TYPES so the migration tooling
// and any straggling old DLLs in the field can still issue reads — but new
// records of that type are no longer written by any client. Character data
// now lives under the flat 'profile' / 'character' kind.
const VALID_TYPES = new Set(['character', 'profile', 'character-profile']);
const VALID_PROFILE_KINDS = new Set(['hwid', 'ip', 'general', 'character']);

// Accept both shapes that pass validateBotToken:
//   • session token (from /auth/start): {key, session_id, ...}  → user via license
//   • user    token (from /auth/login): {type:'user', user_id, ...} → user direct
// Loader uses the latter; bot DLL uses the former. Both should be able to
// CRUD config records on behalf of their account.
async function resolveAccountId(req) {
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

function nowSec() { return Math.floor(Date.now() / 1000); }

function parseData(row) {
  if (!row) return null;
  const raw = row.data;
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;             // some drivers auto-parse JSON
  try { return JSON.parse(raw); } catch { return {}; }
}

// Validate the (type, a, b) triple. Returns null on success, else an error
// string suitable for a 400 response.
function validateIdent(type, a, b) {
  if (!VALID_TYPES.has(type)) return 'Invalid type';
  if (type === 'character') {
    if (!a) return 'character requires a (charName)';
  } else if (type === 'profile') {
    if (!VALID_PROFILE_KINDS.has(a)) return 'profile requires a∈{hwid,ip,general,character}';
    if (!b) return 'profile requires b (profile name)';
  } else if (type === 'character-profile') {
    if (!a) return 'character-profile requires a (charName)';
    if (!b) return 'character-profile requires b (preset name)';
  }
  // Length guards (tables use VARCHAR(64)).
  if (a && a.length > 64) return 'a too long (>64)';
  if (b && b.length > 64) return 'b too long (>64)';
  return null;
}

// ── GET /record ──────────────────────────────────────────────────────────────
router.get('/record', validateBotToken, async (req, res) => {
  const accountId = await resolveAccountId(req);
  if (!accountId) return res.status(401).json({ error: 'Not authenticated' });

  const type = String(req.query.type || '');
  const a    = String(req.query.a    || '');
  const b    = String(req.query.b    || '');
  const err = validateIdent(type, a, b);
  if (err) return res.status(400).json({ error: err });

  const row = await db('config_records')
    .where({ account_id: accountId, ident_type: type, ident_a: a, ident_b: b })
    .first();
  if (!row) return res.json({ record: null });
  res.json({ record: { data: parseData(row), updated_at: row.updated_at } });
});

// ── PUT /record ──────────────────────────────────────────────────────────────
router.put('/record', validateBotToken, async (req, res) => {
  const accountId = await resolveAccountId(req);
  if (!accountId) return res.status(401).json({ error: 'Not authenticated' });

  const type = String(req.query.type || '');
  const a    = String(req.query.a    || '');
  const b    = String(req.query.b    || '');
  const err = validateIdent(type, a, b);
  if (err) return res.status(400).json({ error: err });

  const { data } = req.body || {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'Missing data object' });
  }

  const dataJson = JSON.stringify(data);
  const where = { account_id: accountId, ident_type: type, ident_a: a, ident_b: b };
  const existing = await db('config_records').where(where).first();
  if (existing) {
    await db('config_records').where(where)
      .update({ data: dataJson, updated_at: nowSec() });
  } else {
    await db('config_records').insert({ ...where, data: dataJson, updated_at: nowSec() });
  }
  res.json({ ok: true });
});

// ── DELETE /record ───────────────────────────────────────────────────────────
router.delete('/record', validateBotToken, async (req, res) => {
  const accountId = await resolveAccountId(req);
  if (!accountId) return res.status(401).json({ error: 'Not authenticated' });

  const type = String(req.query.type || '');
  const a    = String(req.query.a    || '');
  const b    = String(req.query.b    || '');
  const err = validateIdent(type, a, b);
  if (err) return res.status(400).json({ error: err });

  await db('config_records')
    .where({ account_id: accountId, ident_type: type, ident_a: a, ident_b: b })
    .delete();

  // If the deleted record was active, clear the active pointer too.
  let scope = null;
  if (type === 'profile' && b) scope = `profile:${a}`;
  else if (type === 'character-profile' && a) scope = `character-profile:${a}`;
  if (scope) {
    const act = await db('config_actives')
      .where({ account_id: accountId, scope }).first();
    if (act && act.active_name === b) {
      await db('config_actives')
        .where({ account_id: accountId, scope })
        .delete();
    }
  }
  res.json({ ok: true });
});

// ── GET /list ────────────────────────────────────────────────────────────────
router.get('/list', validateBotToken, async (req, res) => {
  const accountId = await resolveAccountId(req);
  if (!accountId) return res.status(401).json({ error: 'Not authenticated' });

  const type = String(req.query.type || '');
  const a    = String(req.query.a    || '');
  if (!VALID_TYPES.has(type)) return res.status(400).json({ error: 'Invalid type' });
  // For "profile" lists, a is required (the kind). For "character-profile"
  // lists, a is required (the charName). For "character", a is optional and
  // returns all character rows.
  if (type === 'profile' && !VALID_PROFILE_KINDS.has(a)) {
    return res.status(400).json({ error: 'profile list requires a∈{hwid,ip,general}' });
  }
  if (type === 'character-profile' && !a) {
    return res.status(400).json({ error: 'character-profile list requires a' });
  }

  const q = db('config_records')
    .where({ account_id: accountId, ident_type: type })
    .orderBy('ident_b');
  if (a) q.where('ident_a', a);
  const rows = await q.select('ident_a', 'ident_b', 'data', 'updated_at');

  const records = rows.map((r) => ({
    a:          r.ident_a,
    b:          r.ident_b,
    data:       parseData(r),
    updated_at: r.updated_at,
  }));
  res.json({ records });
});

// ── GET /active ──────────────────────────────────────────────────────────────
router.get('/active', validateBotToken, async (req, res) => {
  const accountId = await resolveAccountId(req);
  if (!accountId) return res.status(401).json({ error: 'Not authenticated' });

  const scope = String(req.query.scope || '');
  if (!scope) return res.status(400).json({ error: 'Missing scope' });

  const row = await db('config_actives')
    .where({ account_id: accountId, scope })
    .first();
  res.json({ name: row ? row.active_name : '' });
});

// ── PUT /active ──────────────────────────────────────────────────────────────
router.put('/active', validateBotToken, async (req, res) => {
  const accountId = await resolveAccountId(req);
  if (!accountId) return res.status(401).json({ error: 'Not authenticated' });

  const scope = String(req.query.scope || '');
  if (!scope) return res.status(400).json({ error: 'Missing scope' });

  const { name } = req.body || {};
  if (typeof name !== 'string') {
    return res.status(400).json({ error: 'Missing name string' });
  }
  if (name.length > 64) return res.status(400).json({ error: 'name too long (>64)' });

  // Empty name = clear active pointer.
  if (name === '') {
    await db('config_actives')
      .where({ account_id: accountId, scope }).delete();
    return res.json({ ok: true });
  }

  const where = { account_id: accountId, scope };
  const existing = await db('config_actives').where(where).first();
  if (existing) {
    await db('config_actives').where(where)
      .update({ active_name: name, updated_at: nowSec() });
  } else {
    await db('config_actives').insert({ ...where, active_name: name, updated_at: nowSec() });
  }
  res.json({ ok: true });
});

// ── POST /share ──────────────────────────────────────────────────────────────
// Persist a PortableExport JSON snapshot. Returns an opaque share_id that
// can be embedded in a URL and given to other users to import. Later edits
// to the creator's profiles do not modify the saved snapshot.
router.post('/share', validateBotToken, async (req, res) => {
  const accountId = await resolveAccountId(req);
  if (!accountId) return res.status(401).json({ error: 'Not authenticated' });

  const { data } = req.body || {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'Missing data object' });
  }
  if (data.format !== 'rabbit-config-export') {
    return res.status(400).json({ error: 'Not a Rabbit config export' });
  }
  const dataJson = JSON.stringify(data);
  if (dataJson.length > 1024 * 1024) {
    return res.status(413).json({ error: 'Snapshot too large (>1 MB)' });
  }

  // 16 hex chars = 64 bits of entropy. Plenty unguessable for a share URL.
  let id = randomBytes(8).toString('hex');
  // Vanishingly unlikely collision; one retry just to be sure.
  if (await db('config_shares').where('share_id', id).first()) {
    id = randomBytes(8).toString('hex');
  }
  // shareName is the human-readable label the sender picked at export time;
  // it's also embedded inside the PortableExport blob, but we mirror it as
  // a top-level column so /shares can display it without parsing every row.
  let shareName = '';
  if (typeof data.shareName === 'string') shareName = data.shareName.trim().slice(0, 96);
  await db('config_shares').insert({
    share_id:   id,
    account_id: accountId,
    share_name: shareName,
    data:       dataJson,
    created_at: nowSec(),
    active:     true,
  });
  res.json({ id });
});

// ── GET /share/:id ───────────────────────────────────────────────────────────
// Fetch a stored snapshot by share_id. Auth is required so anonymous web
// scraping can't enumerate shares — but any authenticated bot user with the
// id can pull it (intended sharing surface).
//
// Inactive (soft-deactivated) shares 404 to everyone except the creator —
// the creator still gets the body so they can preview before reactivating.
router.get('/share/:id', validateBotToken, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id || id.length > 32) return res.status(400).json({ error: 'Invalid id' });

  const row = await db('config_shares').where('share_id', id).first();
  if (!row) return res.status(404).json({ error: 'Share not found' });

  if (row.active === false || row.active === 0) {
    const accountId = await resolveAccountId(req);
    if (!accountId || Number(accountId) !== Number(row.account_id)) {
      return res.status(404).json({ error: 'Share not found' });
    }
  }

  res.json({ data: parseData(row), created_at: row.created_at });
});

// ── GET /shares ──────────────────────────────────────────────────────────────
// List the caller's own shares (account-scoped). Returns metadata only —
// the contents are immutable and not meant to be re-edited; the user needs
// to know what they shared and a way to deactivate it.
//
// Query param `include_inactive=1` surfaces soft-deactivated shares too so
// the user can reactivate them. Default (omitted) returns only active.
router.get('/shares', validateBotToken, async (req, res) => {
  const accountId = await resolveAccountId(req);
  if (!accountId) return res.status(401).json({ error: 'Not authenticated' });

  const includeInactive = String(req.query.include_inactive || '') === '1';
  const q = db('config_shares')
    .where({ account_id: accountId })
    .orderBy('created_at', 'desc')
    .select('share_id', 'share_name', 'data', 'created_at', 'active');
  if (!includeInactive) q.andWhere(function () { this.where('active', true).orWhereNull('active'); });
  const rows = await q;

  const shares = rows.map((r) => {
    const d = parseData(r) || {};
    return {
      id:           r.share_id,
      created_at:   r.created_at,
      exported_at:  typeof d.exportedAt === 'string' ? d.exportedAt : '',
      share_name:   typeof r.share_name === 'string'
                      ? r.share_name
                      : (typeof d.shareName === 'string' ? d.shareName : ''),
      source_kind:  d.source && typeof d.source.kind === 'string' ? d.source.kind : '',
      source_name:  d.source && typeof d.source.name === 'string' ? d.source.name : '',
      tabs:         Array.isArray(d.tabs) ? d.tabs : [],
      key_count:    (d.data && typeof d.data === 'object') ? Object.keys(d.data).length : 0,
      active:       r.active === undefined || r.active === null ? true : !!r.active,
    };
  });
  res.json({ shares });
});

// ── PUT /share/:id/active ────────────────────────────────────────────────────
// Toggle a share's active flag (soft deactivate / reactivate). Only the
// creator can change it.
router.put('/share/:id/active', validateBotToken, async (req, res) => {
  const accountId = await resolveAccountId(req);
  if (!accountId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params.id || '').trim();
  if (!id || id.length > 32) return res.status(400).json({ error: 'Invalid id' });

  const { active } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Missing boolean "active"' });
  }

  const updated = await db('config_shares')
    .where({ share_id: id, account_id: accountId })
    .update({ active });
  if (!updated) return res.status(404).json({ error: 'Share not found' });
  res.json({ ok: true, active });
});

// ── DELETE /share/:id ────────────────────────────────────────────────────────
// Soft-deactivate the caller's own share — same effect as PUT /active with
// active=false. Kept as a separate verb so older clients keep working
// (the old client called DELETE expecting a hard delete; now it's soft).
router.delete('/share/:id', validateBotToken, async (req, res) => {
  const accountId = await resolveAccountId(req);
  if (!accountId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params.id || '').trim();
  if (!id || id.length > 32) return res.status(400).json({ error: 'Invalid id' });

  const updated = await db('config_shares')
    .where({ share_id: id, account_id: accountId })
    .update({ active: false });
  if (!updated) return res.status(404).json({ error: 'Share not found' });
  res.json({ ok: true });
});

// ── GET /characters ──────────────────────────────────────────────────────────
router.get('/characters', validateBotToken, async (req, res) => {
  const accountId = await resolveAccountId(req);
  if (!accountId) return res.status(401).json({ error: 'Not authenticated' });

  // Distinct charNames across both 'character' and 'character-profile' rows.
  const rows = await db('config_records')
    .where({ account_id: accountId })
    .whereIn('ident_type', ['character', 'character-profile'])
    .distinct('ident_a')
    .orderBy('ident_a');
  const characters = rows.map((r) => r.ident_a).filter(Boolean);
  res.json({ characters });
});

export default router;
