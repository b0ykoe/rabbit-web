import { Router } from 'express';
import db from '../db.js';
import { validateBotToken } from '../middleware/botToken.js';

const router = Router();

// C-3: user_id comes from the signed session-token payload (req.botToken.key
// → licenses row → user_id), never from an unsigned session_id field.
async function resolveUserId(req) {
  const licenseKey = req.botToken?.key;
  if (!licenseKey) return null;
  const license = await db('licenses').where('license_key', licenseKey).first();
  return license?.user_id || null;
}

// Use empty string for global/hwid (MySQL NULL breaks unique constraints)
function resolveCharName(configType, req) {
  if (configType === 'character') return req.query?.name || req.body?.name || null;
  return ''; // global and hwid use empty string
}

// ── GET: load or auto-create ─────────────────────────────────────────────────

async function getConfig(req, res, configType) {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const charName = resolveCharName(configType, req);
  if (configType === 'character' && !charName) {
    return res.status(400).json({ error: 'Missing name parameter' });
  }

  let row = await db('bot_configs')
    .where({ user_id: userId, config_type: configType, char_name: charName })
    .first();

  // Auto-create empty config if not found
  if (!row) {
    await db('bot_configs').insert({
      user_id: userId, config_type: configType, char_name: charName, config_json: '{}',
    });
    return res.json({ config: {} });
  }

  try {
    res.json({ config: JSON.parse(row.config_json) });
  } catch {
    res.json({ config: {} });
  }
}

// ── PUT/POST: save (upsert) ──────────────────────────────────────────────────

async function putConfig(req, res, configType) {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const { config } = req.body || {};
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Missing config object' });
  }

  const charName = resolveCharName(configType, req);
  if (configType === 'character' && !charName) {
    return res.status(400).json({ error: 'Missing name field' });
  }

  const configJson = JSON.stringify(config);
  const where = { user_id: userId, config_type: configType, char_name: charName };

  const existing = await db('bot_configs').where(where).first();
  if (existing) {
    await db('bot_configs').where('id', existing.id)
      .update({ config_json: configJson, updated_at: db.fn.now() });
  } else {
    await db('bot_configs').insert({ ...where, config_json: configJson });
  }

  res.json({ ok: true });
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.get('/character',  validateBotToken, (req, res) => getConfig(req, res, 'character'));
router.put('/character',  validateBotToken, (req, res) => putConfig(req, res, 'character'));
router.post('/character', validateBotToken, (req, res) => putConfig(req, res, 'character'));

router.get('/global',  validateBotToken, (req, res) => getConfig(req, res, 'global'));
router.put('/global',  validateBotToken, (req, res) => putConfig(req, res, 'global'));
router.post('/global', validateBotToken, (req, res) => putConfig(req, res, 'global'));

router.get('/hwid',  validateBotToken, (req, res) => getConfig(req, res, 'hwid'));
router.put('/hwid',  validateBotToken, (req, res) => putConfig(req, res, 'hwid'));
router.post('/hwid', validateBotToken, (req, res) => putConfig(req, res, 'hwid'));

export default router;
