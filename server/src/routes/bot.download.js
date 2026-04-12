import { Router } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import db from '../db.js';
import { validateBotToken, validateBotUserToken } from '../middleware/botToken.js';
import { encryptFile } from '../crypto/aes.js';

const router = Router();

// GET /api/bot/version — active release versions, filtered by user's channels
router.get('/version', validateBotUserToken, async (req, res) => {
  const channels = req.botUser.allowed_channels;

  const releases = await db('releases')
    .where('active', true)
    .whereIn('channel', channels)
    .select('type', 'version', 'channel');

  const out = {};
  for (const r of releases) {
    if (!out[r.type]) out[r.type] = {};
    out[r.type][r.channel] = r.version;
  }
  res.json(out);
});

// GET /api/bot/changelog — release notes, filtered by user's channels
router.get('/changelog', validateBotUserToken, async (req, res) => {
  const type     = ['dll', 'loader'].includes(req.query.type) ? req.query.type : 'dll';
  const limit    = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const channels = req.botUser.allowed_channels;

  // Optional channel filter
  const channel = req.query.channel;
  const filterChannels = (channel && channels.includes(channel))
    ? [channel]
    : channels;

  const releases = await db('releases')
    .where('type', type)
    .whereIn('channel', filterChannels)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select('version', 'channel', 'changelog', 'created_at', 'active');

  res.json(releases);
});

// POST /api/bot/download/dll — serve AES-encrypted DLL (user token via Authorization header)
router.post('/download/dll', validateBotUserToken, async (req, res) => {
  await serveRelease(req, res, 'dll');
});

// POST /api/bot/download/loader — serve AES-encrypted loader
router.post('/download/loader', validateBotUserToken, async (req, res) => {
  await serveRelease(req, res, 'loader');
});

async function serveRelease(req, res, type) {
  // Channel from request body (default: release, fallback: any active)
  const channel = ['release', 'beta', 'alpha'].includes(req.body.channel)
    ? req.body.channel
    : null;

  // Verify user has access to the requested channel
  if (channel && !req.botUser.allowed_channels.includes(channel)) {
    return res.status(403).json({ error: 'No access to this channel' });
  }

  let release;
  if (channel) {
    release = await db('releases').where({ type, channel, active: true }).first();
  } else {
    // Fallback: prefer release > beta > alpha
    release = await db('releases').where({ type, channel: 'release', active: true }).first()
           || await db('releases').where({ type, channel: 'beta',    active: true }).first()
           || await db('releases').where({ type, channel: 'alpha',   active: true }).first();
  }

  if (!release || !fs.existsSync(release.file_path)) {
    return res.status(503).json({ error: 'No active release available' });
  }

  const plaintext = fs.readFileSync(release.file_path);
  const { iv, data } = encryptFile(plaintext, req.botTokenRaw);

  res.json({
    sha256:  release.sha256,
    version: release.version,
    channel: release.channel,
    iv,
    data,
  });
}

export default router;
