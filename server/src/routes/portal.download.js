import { Router } from 'express';
import fs from 'node:fs';
import db from '../db.js';

const router = Router();

// GET /api/portal/download/loader?channel=release — download active loader for given channel
router.get('/loader', async (req, res) => {
  const userId = req.session.user.id;
  const userRow = await db('users').where('id', userId).select('allowed_channels').first();
  const channels = userRow?.allowed_channels ? JSON.parse(userRow.allowed_channels) : ['release'];

  // Use requested channel or default to first allowed
  const requestedChannel = req.query.channel || 'release';
  if (!channels.includes(requestedChannel)) {
    return res.status(403).json({ error: 'You do not have access to this channel' });
  }

  const release = await db('releases').where({ type: 'loader', channel: requestedChannel, active: true }).first();
  if (!release || !fs.existsSync(release.file_path)) {
    return res.status(404).json({ error: 'No active loader release available for this channel' });
  }

  const channelSuffix = requestedChannel !== 'release' ? `-${requestedChannel}` : '';
  const filename = `RabbitLoader-v${release.version}${channelSuffix}.exe`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');

  const stream = fs.createReadStream(release.file_path);
  stream.pipe(res);
});

export default router;
