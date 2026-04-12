import { Router } from 'express';
import db from '../db.js';
import { validateBotUserToken } from '../middleware/botToken.js';

const router = Router();

// Resolve user_id from user token (Authorization header) or session_id
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

// ── GET config by type ───────────────────────────────────────────────────────

async function getConfig(req, res, configType) {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const charName = configType === 'character' ? (req.query.name || null) : null;
  if (configType === 'character' && !charName) {
    return res.status(400).json({ error: 'Missing name parameter' });
  }

  const query = { user_id: userId, config_type: configType };
  if (charName) query.char_name = charName;
  else query.char_name = null; // explicit null for global/hwid

  // For MySQL: NULL comparison needs IS NULL
  let row;
  if (charName) {
    row = await db('bot_configs').where(query).first();
  } else {
    row = await db('bot_configs')
      .where({ user_id: userId, config_type: configType })
      .whereNull('char_name')
      .first();
  }

  if (!row) return res.status(404).json({ error: 'No config found' });

  try {
    res.json({ config: JSON.parse(row.config_json) });
  } catch {
    res.json({ config: {} });
  }
}

// ── PUT config by type ───────────────────────────────────────────────────────

async function putConfig(req, res, configType) {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const { config } = req.body || {};
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Missing config object' });
  }

  const charName = configType === 'character' ? (req.body.name || null) : null;
  if (configType === 'character' && !charName) {
    return res.status(400).json({ error: 'Missing name field' });
  }

  const configJson = JSON.stringify(config);

  let existing;
  if (charName) {
    existing = await db('bot_configs')
      .where({ user_id: userId, config_type: configType, char_name: charName })
      .first();
  } else {
    existing = await db('bot_configs')
      .where({ user_id: userId, config_type: configType })
      .whereNull('char_name')
      .first();
  }

  if (existing) {
    await db('bot_configs').where('id', existing.id)
      .update({ config_json: configJson, updated_at: db.fn.now() });
  } else {
    await db('bot_configs').insert({
      user_id: userId,
      config_type: configType,
      char_name: charName,
      config_json: configJson,
    });
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
