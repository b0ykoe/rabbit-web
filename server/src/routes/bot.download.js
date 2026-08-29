import { Router } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import db from '../db.js';
import { validateBotToken, validateBotUserToken } from '../middleware/botToken.js';
import { encryptFile } from '../crypto/aes.js';

const router = Router();

// GET /api/bot/version — active release versions, filtered by user's channels.
// Shape (arch-aware, backward-compatible):
//   { dll: { release: "1.17.34",                    // legacy arch=NULL row
//            beta:    { x86: "1.17.35", x64: "1.17.35" } },  // arch-tagged rows
//     loader: { release: "0.9.1" } }
// Consumers that only read out[type][channel] as a version string still work for
// arch-agnostic rows; loaders that know about arch read the sub-object.
router.get('/version', validateBotUserToken, async (req, res) => {
  const channels = req.botUser.allowed_channels;

  const releases = await db('releases')
    .where('active', true)
    .whereIn('channel', channels)
    .select('type', 'version', 'channel', 'arch');

  const out = {};
  for (const r of releases) {
    if (!out[r.type]) out[r.type] = {};
    if (r.arch) {
      // Arch-tagged row: nest under { x86, x64 }.
      if (typeof out[r.type][r.channel] === 'string') {
        // Prior arch=NULL row already recorded — promote it to the nested shape
        // under an explicit 'any' key so nothing is lost.
        out[r.type][r.channel] = { any: out[r.type][r.channel] };
      } else if (out[r.type][r.channel] == null) {
        out[r.type][r.channel] = {};
      }
      out[r.type][r.channel][r.arch] = r.version;
    } else {
      // arch=NULL (legacy) — keep the old string shape unless we already saw
      // arch-tagged rows for this channel (then nest under 'any').
      if (out[r.type][r.channel] && typeof out[r.type][r.channel] === 'object') {
        out[r.type][r.channel].any = r.version;
      } else {
        out[r.type][r.channel] = r.version;
      }
    }
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

  // Optional target-arch hint (post-047). The loader passes 'x86' or 'x64' once
  // it has confirmed the target game process is running so we can serve the
  // matching build. Absent / malformed → null = "old loader that doesn't know
  // about arch", handled by the fallback chain in pickReleaseForChannel below.
  const arch = (req.body.arch === 'x86' || req.body.arch === 'x64')
    ? req.body.arch
    : null;

  // Per-channel arch resolution (see migration 047):
  //   1. arch given         → active row for that arch; else fall back to the
  //                            arch=NULL legacy row so a channel that still ships
  //                            a single arch-agnostic build stays reachable.
  //   2. arch NOT given     → active arch=NULL row (legacy default); else 'x86'
  //                            (the pre-x64 client default so old loaders that
  //                            never send arch keep working after the admin
  //                            switches to arch-tagged uploads).
  //   3. no match           → null (surfaces as 503; we NEVER serve a wrong-arch
  //                            DLL — that would insta-crash the client).
  const pickReleaseForChannel = async (ch) => {
    if (arch) {
      return (
        await db('releases').where({ type, channel: ch, active: true, arch }).first()
        || await db('releases').where({ type, channel: ch, active: true, arch: null }).first()
        || null
      );
    }
    return (
      await db('releases').where({ type, channel: ch, active: true, arch: null }).first()
      || await db('releases').where({ type, channel: ch, active: true, arch: 'x86' }).first()
      || null
    );
  };

  let release;
  if (channel) {
    release = await pickReleaseForChannel(channel);
  } else {
    // Cross-channel fallback: prefer release > beta > alpha, arch resolution
    // applied inside each probe.
    release = (await pickReleaseForChannel('release'))
           || (await pickReleaseForChannel('beta'))
           || (await pickReleaseForChannel('alpha'));
  }

  if (!release || !fs.existsSync(release.file_path)) {
    // A precise 503 message helps the loader show why a specific arch couldn't
    // be served (e.g. admin has only uploaded x86 so far but the client is x64).
    const msg = arch
      ? `No active ${arch} release available`
      : 'No active release available';
    return res.status(503).json({ error: msg });
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
    // 'x86' | 'x64' | null — echo what the server picked (may differ from what
    // the client asked for when arch fell back to the arch=NULL legacy row).
    arch:    release.arch || null,
    iv,
    data,
  });
}

export default router;
