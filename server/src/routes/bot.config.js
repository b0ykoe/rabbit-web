//
// bot.config.js — legacy /api/bot/config/{global,hwid,ip-profiles,character}
// endpoints, now backed by the new config_records + config_actives tables.
//
// Existing DLLs in the field (and the Phase-1 loader) call these. The shim
// reconstructs the legacy blob shape on read and decomposes it on write so
// the round-trip is observably identical to the old bot_configs flow.
//
// Legacy blob shapes:
//   global:      { ...flat KV... }
//   character:   { ...flat KV... }       (per-charName row)
//   hwid:        { active?, "hwid.<setting>"?, "<profileName>": {serial,owner,...}, ... }
//   ip-profiles: { active?, killswitch?, profiles: { "<name>": {host,port,...} } }
//
// Phase 6 will move clients off these endpoints onto the new fact-based ones,
// at which point this file can be deleted.
//

import { Router } from 'express';
import db from '../db.js';
import { validateBotToken } from '../middleware/botToken.js';

const router = Router();

// Accept both session tokens (with .key) and user tokens (with .user_id).
// Loader hits these legacy endpoints with its user-token from /auth/login,
// the bot DLL with its session-token from /auth/start.
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

function nowSec() { return Math.floor(Date.now() / 1000); }

function parseRowData(row) {
  if (!row) return null;
  const raw = row.data;
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

async function getActiveName(accountId, scope) {
  const row = await db('config_actives')
    .where({ account_id: accountId, scope }).first();
  return row ? row.active_name : '';
}

async function setActiveName(accountId, scope, name) {
  if (!name) {
    await db('config_actives')
      .where({ account_id: accountId, scope }).delete();
    return;
  }
  const where = { account_id: accountId, scope };
  const existing = await db('config_actives').where(where).first();
  if (existing) {
    await db('config_actives').where(where)
      .update({ active_name: name, updated_at: nowSec() });
  } else {
    await db('config_actives').insert({ ...where, active_name: name, updated_at: nowSec() });
  }
}

async function upsertRecord(accountId, type, a, b, data) {
  const where = { account_id: accountId, ident_type: type, ident_a: a, ident_b: b };
  const existing = await db('config_records').where(where).first();
  const dataJson = JSON.stringify(data || {});
  if (existing) {
    await db('config_records').where(where)
      .update({ data: dataJson, updated_at: nowSec() });
  } else {
    await db('config_records').insert({ ...where, data: dataJson, updated_at: nowSec() });
  }
}

// ── Global ───────────────────────────────────────────────────────────────────
// Maps to (user, 'profile', 'general', <active or 'default'>).
async function readGlobal(accountId) {
  const active = (await getActiveName(accountId, 'profile:general')) || 'default';
  const row = await db('config_records')
    .where({ account_id: accountId, ident_type: 'profile', ident_a: 'general', ident_b: active })
    .first();
  return parseRowData(row) || {};
}

async function writeGlobal(accountId, blob) {
  let active = await getActiveName(accountId, 'profile:general');
  if (!active) active = 'default';
  await upsertRecord(accountId, 'profile', 'general', active, blob);
  await setActiveName(accountId, 'profile:general', active);
}

router.get('/global', validateBotToken, async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ config: await readGlobal(userId) });
});

router.put('/global', validateBotToken, async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { config } = req.body || {};
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Missing config object' });
  }
  await writeGlobal(userId, config);
  res.json({ ok: true });
});
router.post('/global', validateBotToken, async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { config } = req.body || {};
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Missing config object' });
  }
  await writeGlobal(userId, config);
  res.json({ ok: true });
});

// ── Character ────────────────────────────────────────────────────────────────
// Maps to (user, 'character-profile', charName, <active or 'default'>).
async function readCharacter(accountId, charName) {
  const active = (await getActiveName(accountId, `character-profile:${charName}`)) || 'default';
  const row = await db('config_records')
    .where({ account_id: accountId, ident_type: 'character-profile',
             ident_a: charName, ident_b: active })
    .first();
  return parseRowData(row) || {};
}

async function writeCharacter(accountId, charName, blob) {
  let active = await getActiveName(accountId, `character-profile:${charName}`);
  if (!active) active = 'default';
  await upsertRecord(accountId, 'character-profile', charName, active, blob);
  await setActiveName(accountId, `character-profile:${charName}`, active);
}

router.get('/character', validateBotToken, async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const charName = req.query?.name;
  if (!charName) return res.status(400).json({ error: 'Missing name parameter' });
  res.json({ config: await readCharacter(userId, String(charName)) });
});

async function characterPutHandler(req, res) {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { config, name } = req.body || {};
  const charName = name || req.query?.name;
  if (!charName) return res.status(400).json({ error: 'Missing name field' });
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Missing config object' });
  }
  await writeCharacter(userId, String(charName), config);
  res.json({ ok: true });
}
router.put('/character',  validateBotToken, characterPutHandler);
router.post('/character', validateBotToken, characterPutHandler);

// ── HWID ─────────────────────────────────────────────────────────────────────
// Reconstructs legacy flat shape: { active, "hwid.<setting>": ..., "<name>": {...} }.
// Settings (hwid.*) are stashed alongside profile bodies during decompose.
// On read, we surface them at the root.
async function readHwid(accountId) {
  const active = await getActiveName(accountId, 'profile:hwid');
  const rows = await db('config_records')
    .where({ account_id: accountId, ident_type: 'profile', ident_a: 'hwid' })
    .select('ident_b', 'data');
  const out = {};
  if (active) out.active = active;
  // Pull hwid.* settings from the active profile body (most recent canonical
  // place we stored them). Legacy callers expect them at the root.
  let activeBody = null;
  for (const r of rows) {
    if (r.ident_b === active) { activeBody = parseRowData(r); break; }
  }
  if (activeBody) {
    for (const [k, v] of Object.entries(activeBody)) {
      if (k.startsWith('hwid.')) out[k] = v;
    }
  }
  // Each profile body becomes a top-level object keyed by name.
  for (const r of rows) {
    const body = parseRowData(r) || {};
    const stripped = {};
    for (const [k, v] of Object.entries(body)) {
      if (k.startsWith('hwid.')) continue; // settings live at root, not inside profiles
      stripped[k] = v;
    }
    out[r.ident_b] = stripped;
  }
  return out;
}

async function writeHwid(accountId, blob) {
  const active = typeof blob.active === 'string' ? blob.active : '';
  const settings = {};
  const profiles = {};
  for (const [k, v] of Object.entries(blob)) {
    if (k === 'active') continue;
    if (k.startsWith('hwid.')) { settings[k] = v; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      profiles[k] = v;
    }
  }
  // Settings go inside the active profile body so the round-trip preserves them.
  const settingsTarget = active || 'default';
  for (const [name, body] of Object.entries(profiles)) {
    const data = (name === settingsTarget) ? { ...body, ...settings } : body;
    await upsertRecord(accountId, 'profile', 'hwid', name, data);
  }
  if (Object.keys(profiles).length === 0 && Object.keys(settings).length > 0) {
    await upsertRecord(accountId, 'profile', 'hwid', 'default', settings);
  }
  // Determine which existing records were dropped from the new blob and delete them.
  const existing = await db('config_records')
    .where({ account_id: accountId, ident_type: 'profile', ident_a: 'hwid' })
    .select('ident_b');
  for (const r of existing) {
    if (!Object.prototype.hasOwnProperty.call(profiles, r.ident_b)) {
      // Don't delete the synthetic 'default' if we just wrote settings into it.
      if (r.ident_b === 'default' &&
          Object.keys(profiles).length === 0 &&
          Object.keys(settings).length > 0) continue;
      await db('config_records')
        .where({ account_id: accountId, ident_type: 'profile', ident_a: 'hwid', ident_b: r.ident_b })
        .delete();
    }
  }
  await setActiveName(accountId, 'profile:hwid', active);
}

router.get('/hwid', validateBotToken, async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ config: await readHwid(userId) });
});

async function hwidPutHandler(req, res) {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { config } = req.body || {};
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Missing config object' });
  }
  await writeHwid(userId, config);
  res.json({ ok: true });
}
router.put('/hwid',  validateBotToken, hwidPutHandler);
router.post('/hwid', validateBotToken, hwidPutHandler);

// ── IP profiles ──────────────────────────────────────────────────────────────
// Legacy shape: { active, killswitch, profiles: {name: {...}} }.
// Killswitch is stored on the active profile body under "_killswitch".
async function readIp(accountId) {
  const active = await getActiveName(accountId, 'profile:ip');
  const rows = await db('config_records')
    .where({ account_id: accountId, ident_type: 'profile', ident_a: 'ip' })
    .select('ident_b', 'data');
  const profiles = {};
  let killswitch = false;
  for (const r of rows) {
    const body = parseRowData(r) || {};
    if (body._killswitch && r.ident_b === active) killswitch = true;
    const stripped = { ...body };
    delete stripped._killswitch;
    profiles[r.ident_b] = stripped;
  }
  return {
    active:     active || '',
    killswitch,
    profiles,
  };
}

async function writeIp(accountId, blob) {
  const active = typeof blob.active === 'string' ? blob.active : '';
  const killswitch = !!blob.killswitch;
  const profiles = (blob.profiles && typeof blob.profiles === 'object') ? blob.profiles : {};

  const ksTarget = active || 'default';
  for (const [name, body] of Object.entries(profiles)) {
    if (!body || typeof body !== 'object') continue;
    const data = (name === ksTarget) ? { ...body, _killswitch: killswitch } : { ...body };
    delete data._killswitch_off;  // tidy in case of round-trip glitches
    if (name !== ksTarget) delete data._killswitch;
    await upsertRecord(accountId, 'profile', 'ip', name, data);
  }
  if (Object.keys(profiles).length === 0 && killswitch) {
    await upsertRecord(accountId, 'profile', 'ip', 'default', { _killswitch: true });
  }
  // Delete records that are no longer in the blob.
  const existing = await db('config_records')
    .where({ account_id: accountId, ident_type: 'profile', ident_a: 'ip' })
    .select('ident_b');
  for (const r of existing) {
    if (!Object.prototype.hasOwnProperty.call(profiles, r.ident_b)) {
      if (r.ident_b === 'default' &&
          Object.keys(profiles).length === 0 && killswitch) continue;
      await db('config_records')
        .where({ account_id: accountId, ident_type: 'profile', ident_a: 'ip', ident_b: r.ident_b })
        .delete();
    }
  }
  await setActiveName(accountId, 'profile:ip', active);
}

router.get('/ip-profiles', validateBotToken, async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ config: await readIp(userId) });
});

async function ipPutHandler(req, res) {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { config } = req.body || {};
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Missing config object' });
  }
  await writeIp(userId, config);
  res.json({ ok: true });
}
router.put('/ip-profiles',  validateBotToken, ipPutHandler);
router.post('/ip-profiles', validateBotToken, ipPutHandler);

export default router;
