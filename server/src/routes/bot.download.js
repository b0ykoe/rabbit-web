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

  // Verify user has access to the requested channel. W-12: probing for
  // unauthorized channels leaves an audit trail so super-admins can spot
  // clients brute-forcing channel names.
  if (channel && !req.botUser.allowed_channels.includes(channel)) {
    await db('audit_logs').insert({
      user_id:      req.botUser.id,
      action:       'channel_denied',
      subject_type: 'release',
      subject_id:   type,
      new_values:   JSON.stringify({ requested_channel: channel, allowed_channels: req.botUser.allowed_channels }),
      ip_address:   req.ip || null,
      user_agent:   (req.get('user-agent') || '').slice(0, 255) || null,
    });
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

  // W-8: detached Ed25519 signature over the *plaintext* bytes. Bot
  // decrypts AES, then verifies `sig` against the plaintext with the
  // pinned public key before loading/executing. Older releases without
  // a stored signature fall back to sha256-only verification.
  if (release.dll_signature) {
    res.setHeader('X-Release-Signature', release.dll_signature);
  }

  res.json({
    sha256:  release.sha256,
    version: release.version,
    channel: release.channel,
    iv,
    data,
  });
}

export default router;
