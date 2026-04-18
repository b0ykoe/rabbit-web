import { Router } from 'express';
import db from '../db.js';
import { config } from '../config.js';
import { recordAudit } from '../services/auditLog.js';
import { generateKey } from '../services/licenseService.js';
import { validate, createLicenseSchema, updateLicenseSchema, extendLicenseSchema, assignLicenseSchema } from '../validation/schemas.js';

const router = Router();

// GET /api/admin/licenses — paginated list with user + live session count
router.get('/', async (req, res) => {
  const page   = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit  = 25;
  const offset = (page - 1) * limit;
  const cutoff = Math.floor(Date.now() / 1000) - config.bot.sessionTimeoutSec;

  const [rows, countResult] = await Promise.all([
    db('licenses')
      .leftJoin('users', 'licenses.user_id', 'users.id')
      .leftJoin('users as purchaser', 'licenses.purchased_by', 'purchaser.id')
      .select(
        'licenses.license_key',
        'licenses.user_id',
        'licenses.purchased_by',
        'licenses.max_sessions',
        'licenses.active',
        'licenses.note',
        'licenses.expires_at',
        'licenses.bound_hwid',
        'licenses.created_at',
        'users.name as user_name',
        'users.email as user_email',
        'purchaser.name as purchased_by_name',
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
  const { max_sessions, note, expires_at } = req.validated;
  const key = generateKey();

  await db('licenses').insert({
    license_key:  key,
    max_sessions,
    note:         note || null,
    expires_at:   expires_at || null,
    active:       true,
  });

  await recordAudit(db, req, {
    action: 'license.create', subjectType: 'license', subjectId: key,
    newValues: { license_key: key, max_sessions, note, expires_at },
  });

  res.status(201).json({ license_key: key, max_sessions, note, expires_at });
});

// PATCH /api/admin/licenses/:key — edit license
router.patch('/:key', validate(updateLicenseSchema), async (req, res) => {
  const { key } = req.params;
  const lic = await db('licenses').where('license_key', key).first();
  if (!lic) return res.status(404).json({ error: 'License not found' });

  const updates = {};
  const oldValues = {};
  const newValues = {};

  for (const field of ['max_sessions', 'note', 'expires_at']) {
    if (req.validated[field] !== undefined) {
      oldValues[field] = lic[field];
      newValues[field] = req.validated[field];
      updates[field]   = req.validated[field];
    }
  }

  if (Object.keys(updates).length === 0) return res.json({ message: 'No changes' });

  await db('licenses').where('license_key', key).update(updates);
  await recordAudit(db, req, {
    action: 'license.update', subjectType: 'license', subjectId: key, oldValues, newValues,
  });

  res.json({ message: 'License updated' });
});

// PATCH /api/admin/licenses/:key/extend — extend expiration
router.patch('/:key/extend', validate(extendLicenseSchema), async (req, res) => {
  const { key } = req.params;
  const lic = await db('licenses').where('license_key', key).first();
  if (!lic) return res.status(404).json({ error: 'License not found' });

  let newExpiry;
  if (req.validated.expires_at !== undefined) {
    // Set explicit date (null = lifetime)
    newExpiry = req.validated.expires_at;
  } else if (req.validated.days) {
    // Add days from current expiry (or from now if expired/null)
    const base = lic.expires_at && new Date(lic.expires_at) > new Date()
      ? new Date(lic.expires_at)
      : new Date();
    base.setDate(base.getDate() + req.validated.days);
    newExpiry = base.toISOString().slice(0, 19).replace('T', ' ');
  }

  await db('licenses').where('license_key', key).update({ expires_at: newExpiry });
  await recordAudit(db, req, {
    action: 'license.extend', subjectType: 'license', subjectId: key,
    oldValues: { expires_at: lic.expires_at },
    newValues: { expires_at: newExpiry },
  });

  res.json({ expires_at: newExpiry, message: 'License extended' });
});

// PATCH /api/admin/licenses/:key/revoke
router.patch('/:key/revoke', async (req, res) => {
  const { key } = req.params;
  const lic = await db('licenses').where('license_key', key).first();
  if (!lic) return res.status(404).json({ error: 'License not found' });

  await db('licenses').where('license_key', key).update({ active: false });
  // W-2: any outstanding signed tokens for this key are now invalid —
  // bump token_version so the next heartbeat/verify rejects them.
  await db('licenses').where('license_key', key).increment('token_version', 1);
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

// PATCH /api/admin/licenses/:key/reset-hwid — admin resets bound HWID
router.patch('/:key/reset-hwid', async (req, res) => {
  const { key } = req.params;
  const lic = await db('licenses').where('license_key', key).first();
  if (!lic) return res.status(404).json({ error: 'License not found' });
  if (!lic.bound_hwid) return res.json({ message: 'No HWID bound' });

  await db('licenses').where('license_key', key).update({ bound_hwid: null });
  // W-2: invalidate outstanding tokens bound to the old HWID.
  await db('licenses').where('license_key', key).increment('token_version', 1);
  // Archive active sessions for this key so the new HWID can connect
  const { archiveSessionsByKey } = await import('../services/licenseService.js');
  await archiveSessionsByKey(db, key, 'hwid_reset');

  await recordAudit(db, req, {
    action: 'license.reset_hwid', subjectType: 'license', subjectId: key,
    oldValues: { bound_hwid: lic.bound_hwid },
    newValues: { bound_hwid: null },
  });

  res.json({ message: 'HWID reset' });
});

export default router;
