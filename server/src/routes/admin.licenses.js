import { Router } from 'express';
import db from '../db.js';
import { recordAudit } from '../services/auditLog.js';
import { generateKey } from '../services/licenseService.js';
import { validate, createLicenseSchema, assignLicenseSchema } from '../validation/schemas.js';

const router = Router();

// GET /api/admin/licenses — paginated list with user + live session count
router.get('/', async (req, res) => {
  const page   = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit  = 25;
  const offset = (page - 1) * limit;
  const cutoff = Math.floor(Date.now() / 1000) - 90;

  const [rows, countResult] = await Promise.all([
    db('licenses')
      .leftJoin('users', 'licenses.user_id', 'users.id')
      .select(
        'licenses.license_key',
        'licenses.user_id',
        'licenses.max_sessions',
        'licenses.active',
        'licenses.note',
        'licenses.created_at',
        'users.name as user_name',
        'users.email as user_email',
      )
      .orderBy('licenses.created_at', 'desc')
      .limit(limit)
      .offset(offset),
    db('licenses').count('* as total').first(),
  ]);

  // Attach live session count
  if (rows.length) {
    const keys = rows.map(r => r.license_key);
    const counts = await db('bot_sessions')
      .whereIn('license_key', keys)
      .where('last_heartbeat', '>', cutoff)
      .groupBy('license_key')
      .select('license_key', db.raw('COUNT(*) as live_count'));
    const countMap = Object.fromEntries(counts.map(c => [c.license_key, Number(c.live_count)]));
    for (const r of rows) r.live_sessions = countMap[r.license_key] || 0;
  }

  // Fetch all users for assign dropdown
  const users = await db('users').select('id', 'name', 'email').orderBy('name');

  res.json({
    data: rows,
    users,
    page,
    totalPages: Math.ceil(Number(countResult.total) / limit),
    total:      Number(countResult.total),
  });
});

// POST /api/admin/licenses — create new key
router.post('/', validate(createLicenseSchema), async (req, res) => {
  const { max_sessions, note } = req.validated;
  const key = generateKey();

  await db('licenses').insert({
    license_key:  key,
    max_sessions,
    note:         note || null,
    active:       true,
  });

  await recordAudit(db, req, {
    action: 'license.create', subjectType: 'license', subjectId: key,
    newValues: { license_key: key, max_sessions, note },
  });

  res.status(201).json({ license_key: key, max_sessions, note });
});

// PATCH /api/admin/licenses/:key/revoke
router.patch('/:key/revoke', async (req, res) => {
  const { key } = req.params;
  const lic = await db('licenses').where('license_key', key).first();
  if (!lic) return res.status(404).json({ error: 'License not found' });

  await db('licenses').where('license_key', key).update({ active: false });
  await recordAudit(db, req, {
    action: 'license.revoke', subjectType: 'license', subjectId: key,
    oldValues: { active: true }, newValues: { active: false },
  });

  res.json({ message: 'License revoked' });
});

// PATCH /api/admin/licenses/:key/assign — assign/unassign user
router.patch('/:key/assign', validate(assignLicenseSchema), async (req, res) => {
  const { key } = req.params;
  const { user_id } = req.validated;

  const lic = await db('licenses').where('license_key', key).first();
  if (!lic) return res.status(404).json({ error: 'License not found' });

  await db('licenses').where('license_key', key).update({ user_id });
  await recordAudit(db, req, {
    action: 'license.assign', subjectType: 'license', subjectId: key,
    oldValues: { user_id: lic.user_id }, newValues: { user_id },
  });

  res.json({ message: user_id ? 'License assigned' : 'License unassigned' });
});

export default router;
