import { Router } from 'express';
import db from '../db.js';
import { recordAudit } from '../services/auditLog.js';

const router = Router();

// GET /api/admin/settings — all settings as key-value object
router.get('/', async (req, res) => {
  const rows = await db('settings').select('key', 'value');
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  res.json(settings);
});

// PATCH /api/admin/settings/:key — update a setting
router.patch('/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  if (value === undefined || value === null) {
    return res.status(422).json({ error: 'value is required' });
  }

  const existing = await db('settings').where('key', key).first();
  if (!existing) {
    return res.status(404).json({ error: 'Setting not found' });
  }

  const oldValue = existing.value;
  await db('settings').where('key', key).update({ value: String(value) });

  await recordAudit(db, req, {
    action: 'settings.update',
    subjectType: 'setting',
    subjectId: key,
    oldValues: { value: oldValue },
    newValues: { value: String(value) },
  });

  res.json({ key, value: String(value) });
});

export default router;
