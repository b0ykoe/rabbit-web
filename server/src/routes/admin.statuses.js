import { Router } from 'express';
import db from '../db.js';
import { recordAudit } from '../services/auditLog.js';

const router = Router();

// GET /api/admin/statuses — all (active first, then archived history)
router.get('/', async (req, res) => {
  const statuses = await db('global_statuses')
    .orderBy('active', 'desc')
    .orderBy('created_at', 'desc');
  res.json(statuses);
});

// POST /api/admin/statuses — create new status
router.post('/', async (req, res) => {
  const { message, color, starts_at, ends_at } = req.body;
  if (!message) return res.status(422).json({ error: 'Message is required' });
  if (!['info', 'warning', 'error', 'success'].includes(color)) {
    return res.status(422).json({ error: 'Invalid color' });
  }

  const [id] = await db('global_statuses').insert({
    message, color, active: true,
    starts_at: starts_at || null,
    ends_at:   ends_at || null,
  });

  await recordAudit(db, req, {
    action: 'status.create', subjectType: 'global_status', subjectId: id,
    newValues: { message, color, starts_at, ends_at },
  });

  res.status(201).json({ id, message, color, active: true });
});

// PATCH /api/admin/statuses/:id — toggle/update (archive = set active:false)
router.patch('/:id', async (req, res) => {
  const status = await db('global_statuses').where('id', req.params.id).first();
  if (!status) return res.status(404).json({ error: 'Status not found' });

  const updates = {};
  if (req.body.active !== undefined) updates.active = req.body.active;
  if (req.body.message) updates.message = req.body.message;
  if (req.body.color && ['info', 'warning', 'error', 'success'].includes(req.body.color)) updates.color = req.body.color;
  if (req.body.starts_at !== undefined) updates.starts_at = req.body.starts_at || null;
  if (req.body.ends_at !== undefined) updates.ends_at = req.body.ends_at || null;

  if (Object.keys(updates).length === 0) return res.json({ message: 'No changes' });

  await db('global_statuses').where('id', status.id).update(updates);
  await recordAudit(db, req, {
    action: updates.active === false ? 'status.archive' : 'status.update',
    subjectType: 'global_status', subjectId: status.id,
    oldValues: { active: status.active, message: status.message },
    newValues: updates,
  });

  res.json({ message: 'Status updated' });
});

// No DELETE — statuses are archived, never deleted. History is preserved.

export default router;
