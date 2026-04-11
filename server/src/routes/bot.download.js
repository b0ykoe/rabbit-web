import { Router } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import db from '../db.js';
import { validateBotToken } from '../middleware/botToken.js';
import { encryptFile } from '../crypto/aes.js';

const router = Router();

// GET /api/bot/version — active release versions
router.get('/version', async (req, res) => {
  const releases = await db('releases').where('active', true).select('type', 'version');
  const out = {};
  for (const r of releases) out[r.type] = r.version;
  res.json(out);
});

// GET /api/bot/changelog — paginated release notes
router.get('/changelog', async (req, res) => {
  const type  = ['dll', 'loader'].includes(req.query.type) ? req.query.type : 'dll';
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

  const releases = await db('releases')
    .where('type', type)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select('version', 'changelog', 'created_at', 'active');

  res.json(releases);
});

// POST /api/bot/download/dll — serve AES-encrypted DLL
router.post('/download/dll', validateBotToken, async (req, res) => {
  await serveRelease(req, res, 'dll');
});

// POST /api/bot/download/loader — serve AES-encrypted loader
router.post('/download/loader', validateBotToken, async (req, res) => {
  await serveRelease(req, res, 'loader');
});

async function serveRelease(req, res, type) {
  const release = await db('releases').where({ type, active: true }).first();
  if (!release || !fs.existsSync(release.file_path)) {
    return res.status(503).json({ error: 'No active release available' });
  }

  const plaintext = fs.readFileSync(release.file_path);
  const { iv, data } = encryptFile(plaintext, req.botTokenRaw);

  res.json({
    sha256: release.sha256,
    iv,
    data,
  });
}

export default router;
