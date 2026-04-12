import { Router } from 'express';
import db from '../db.js';
import { validateBotUserToken } from '../middleware/botToken.js';

const router = Router();

async function resolveUserId(req) {
  if (req.botUser?.id) return req.botUser.id;
  const sessionId = req.query?.session_id || req.body?.session_id;
  if (sessionId) {
    const session = await db('bot_sessions').where({ session_id: sessionId, active: true }).first();
    if (session) {
      const license = await db('licenses').where('license_key', session.license_key).first();
      if (license?.user_id) return license.user_id;
    }
  }
  return null;
}

async function optionalUserToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return validateBotUserToken(req, res, next);
  next();
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

router.get('/character',  optionalUserToken, (req, res) => getConfig(req, res, 'character'));
router.put('/character',  optionalUserToken, (req, res) => putConfig(req, res, 'character'));
router.post('/character', optionalUserToken, (req, res) => putConfig(req, res, 'character'));

router.get('/global',  optionalUserToken, (req, res) => getConfig(req, res, 'global'));
router.put('/global',  optionalUserToken, (req, res) => putConfig(req, res, 'global'));
router.post('/global', optionalUserToken, (req, res) => putConfig(req, res, 'global'));

router.get('/hwid',  optionalUserToken, (req, res) => getConfig(req, res, 'hwid'));
router.put('/hwid',  optionalUserToken, (req, res) => putConfig(req, res, 'hwid'));
router.post('/hwid', optionalUserToken, (req, res) => putConfig(req, res, 'hwid'));

export default router;
