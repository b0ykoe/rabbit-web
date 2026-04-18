import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db from '../db.js';
import { config } from '../config.js';
import { recordAudit } from '../services/auditLog.js';
import { signBytes } from '../crypto/ed25519.js';
import { validate, uploadReleaseSchema, updateReleaseSchema } from '../validation/schemas.js';

const upload = multer({ dest: path.join(config.bot.privateDir, '_tmp'), limits: { fileSize: 50 * 1024 * 1024 } });
const router = Router();

// GET /api/admin/releases — all releases grouped by type
router.get('/', async (req, res) => {
  const releases = await db('releases').orderBy('created_at', 'desc')
    .select('id', 'type', 'channel', 'version', 'sha256', 'md5', 'changelog', 'active', 'created_at');

  const grouped = { dll: [], loader: [] };
  for (const r of releases) {
    (grouped[r.type] || []).push(r);
  }

  res.json(grouped);
});

// POST /api/admin/releases — upload new release
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(422).json({ errors: { file: ['File is required'] } });
  }

  const result = uploadReleaseSchema.safeParse(req.body);
  if (!result.success) {
    fs.unlinkSync(req.file.path);
    return res.status(422).json({ errors: result.error.flatten().fieldErrors });
  }

  const { type, channel, version, changelog } = result.data;

  const exists = await db('releases').where({ type, version, channel }).first();
  if (exists) {
    fs.unlinkSync(req.file.path);
    return res.status(422).json({ errors: { version: [`Version ${version} already exists for ${type}/${channel}`] } });
  }

  const dir = path.join(config.bot.privateDir, type, channel);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ext      = type === 'dll' ? '.dll' : '.exe';
  const filename = `${version}${ext}`;
  const filePath = path.join(dir, filename);

  fs.renameSync(req.file.path, filePath);

  // Compute SHA-256, MD5, and a detached Ed25519 signature over the raw
  // bytes so the bot can verify the artifact on download (W-8).
  const fileBuffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const md5    = crypto.createHash('md5').update(fileBuffer).digest('hex');
  const dll_signature = await signBytes(fileBuffer, config.bot.ed25519PrivateKey);

  const [id] = await db('releases').insert({
    type, channel, version, file_path: filePath, sha256, md5, dll_signature, changelog, active: false,
  });

  // Deactivate others of same type + channel, activate this one
  await db('releases').where({ type, channel }).whereNot('id', id).update({ active: false });
  await db('releases').where('id', id).update({ active: true });

  await recordAudit(db, req, {
    action: 'release.upload', subjectType: 'release', subjectId: id,
    newValues: { type, channel, version, sha256, md5 },
  });

  res.status(201).json({ id, type, channel, version, sha256, md5, message: `Release ${type}/${channel} v${version} uploaded and activated` });
});

// PATCH /api/admin/releases/:id — edit changelog + channel
router.patch('/:id', validate(updateReleaseSchema), async (req, res) => {
  const release = await db('releases').where('id', req.params.id).first();
  if (!release) return res.status(404).json({ error: 'Release not found' });

  const updates = {};
  const oldValues = {};
  const newValues = {};

  if (req.validated.changelog && req.validated.changelog !== release.changelog) {
    oldValues.changelog = release.changelog;
    newValues.changelog = req.validated.changelog;
    updates.changelog = req.validated.changelog;
  }

  if (req.validated.channel && req.validated.channel !== release.channel) {
    // Check uniqueness with new channel
    const conflict = await db('releases')
      .where({ type: release.type, version: release.version, channel: req.validated.channel })
      .whereNot('id', release.id)
      .first();
    if (conflict) {
      return res.status(422).json({ error: `Version ${release.version} already exists in ${req.validated.channel} channel` });
    }
    oldValues.channel = release.channel;
    newValues.channel = req.validated.channel;
    updates.channel = req.validated.channel;
  }

  if (Object.keys(updates).length === 0) return res.json({ message: 'No changes' });

  await db('releases').where('id', release.id).update(updates);

  await recordAudit(db, req, {
    action: 'release.update', subjectType: 'release', subjectId: release.id,
    oldValues, newValues,
  });

  res.json({ message: `Release ${release.type} v${release.version} updated` });
});

// PATCH /api/admin/releases/:id/activate — activate (rollback/forward)
router.patch('/:id/activate', async (req, res) => {
  const release = await db('releases').where('id', req.params.id).first();
  if (!release) return res.status(404).json({ error: 'Release not found' });

  const previous = await db('releases').where({ type: release.type, channel: release.channel, active: true }).first();

  await db('releases').where({ type: release.type, channel: release.channel }).update({ active: false });
  await db('releases').where('id', release.id).update({ active: true });

  await recordAudit(db, req, {
    action: 'release.activate', subjectType: 'release', subjectId: release.id,
    oldValues: { previous_version: previous?.version },
    newValues: { type: release.type, channel: release.channel, version: release.version },
  });

  res.json({ message: `Activated ${release.type}/${release.channel} v${release.version}` });
});

// PATCH /api/admin/releases/:id/deactivate �� deactivate (no active version for this type+channel)
router.patch('/:id/deactivate', async (req, res) => {
  const release = await db('releases').where('id', req.params.id).first();
  if (!release) return res.status(404).json({ error: 'Release not found' });
  if (!release.active) return res.json({ message: 'Already inactive' });

  await db('releases').where('id', release.id).update({ active: false });

  await recordAudit(db, req, {
    action: 'release.deactivate', subjectType: 'release', subjectId: release.id,
    oldValues: { active: true },
    newValues: { active: false, type: release.type, channel: release.channel, version: release.version },
  });

  res.json({ message: `Deactivated ${release.type}/${release.channel} v${release.version}` });
});

export default router;
