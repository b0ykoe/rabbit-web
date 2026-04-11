import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db from '../db.js';
import { config } from '../config.js';
import { recordAudit } from '../services/auditLog.js';
import { validate, uploadReleaseSchema } from '../validation/schemas.js';

const upload = multer({ dest: path.join(config.bot.privateDir, '_tmp'), limits: { fileSize: 50 * 1024 * 1024 } });
const router = Router();

// GET /api/admin/releases — all releases grouped by type
router.get('/', async (req, res) => {
  const releases = await db('releases').orderBy('created_at', 'desc')
    .select('id', 'type', 'version', 'sha256', 'changelog', 'active', 'created_at');

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

  // Validate text fields
  const result = uploadReleaseSchema.safeParse(req.body);
  if (!result.success) {
    fs.unlinkSync(req.file.path); // cleanup temp file
    return res.status(422).json({ errors: result.error.flatten().fieldErrors });
  }

  const { type, version, changelog } = result.data;

  // Check uniqueness
  const exists = await db('releases').where({ type, version }).first();
  if (exists) {
    fs.unlinkSync(req.file.path);
    return res.status(422).json({ errors: { version: [`Version ${version} already exists for ${type}`] } });
  }

  // Move file to final location
  const dir = path.join(config.bot.privateDir, type);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ext      = type === 'dll' ? '.dll' : '.exe';
  const filename = `${version}${ext}`;
  const filePath = path.join(dir, filename);

  fs.renameSync(req.file.path, filePath);

  // Compute SHA-256
  const fileBuffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // Insert + activate
  const [id] = await db('releases').insert({
    type, version, file_path: filePath, sha256, changelog, active: false,
  });

  // Deactivate others of same type, activate this one
  await db('releases').where('type', type).whereNot('id', id).update({ active: false });
  await db('releases').where('id', id).update({ active: true });

  await recordAudit(db, req, {
    action: 'release.upload', subjectType: 'release', subjectId: id,
    newValues: { type, version, sha256 },
  });

  res.status(201).json({ id, type, version, sha256, message: `Release ${type} v${version} uploaded and activated` });
});

// PATCH /api/admin/releases/:id/activate — activate (rollback/forward)
router.patch('/:id/activate', async (req, res) => {
  const release = await db('releases').where('id', req.params.id).first();
  if (!release) return res.status(404).json({ error: 'Release not found' });

  const previous = await db('releases').where({ type: release.type, active: true }).first();

  await db('releases').where('type', release.type).update({ active: false });
  await db('releases').where('id', release.id).update({ active: true });

  await recordAudit(db, req, {
    action: 'release.activate', subjectType: 'release', subjectId: release.id,
    oldValues: { previous_version: previous?.version },
    newValues: { type: release.type, version: release.version },
  });

  res.json({ message: `Activated ${release.type} v${release.version}` });
});

export default router;
