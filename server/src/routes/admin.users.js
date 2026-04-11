import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { recordAudit } from '../services/auditLog.js';
import { validate, createUserSchema, updateUserSchema } from '../validation/schemas.js';

const router = Router();

// GET /api/admin/users — paginated list
router.get('/', async (req, res) => {
  const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = 25;
  const offset = (page - 1) * limit;

  const [users, countResult] = await Promise.all([
    db('users')
      .select('id', 'name', 'email', 'role', 'force_password_change', 'created_at')
      .orderBy('id', 'asc')
      .limit(limit)
      .offset(offset),
    db('users').count('* as total').first(),
  ]);

  // Attach license count per user
  if (users.length) {
    const ids = users.map(u => u.id);
    const counts = await db('licenses')
      .whereIn('user_id', ids)
      .groupBy('user_id')
      .select('user_id', db.raw('COUNT(*) as license_count'));
    const countMap = Object.fromEntries(counts.map(c => [c.user_id, Number(c.license_count)]));
    for (const u of users) u.license_count = countMap[u.id] || 0;
  }

  res.json({
    data: users,
    page,
    totalPages: Math.ceil(Number(countResult.total) / limit),
    total:      Number(countResult.total),
  });
});

// POST /api/admin/users — create
router.post('/', validate(createUserSchema), async (req, res) => {
  const { name, email, password, role } = req.validated;

  const exists = await db('users').where('email', email).first();
  if (exists) {
    return res.status(422).json({ errors: { email: ['Email already in use'] } });
  }

  const hash = await bcrypt.hash(password, 12);
  const [id] = await db('users').insert({ name, email, password: hash, role });
  await recordAudit(db, req, {
    action: 'user.create', subjectType: 'user', subjectId: id,
    newValues: { name, email, role },
  });

  res.status(201).json({ id, name, email, role });
});

// PATCH /api/admin/users/:id — update
router.patch('/:id', validate(updateUserSchema), async (req, res) => {
  const { id } = req.params;
  const user = await db('users').where('id', id).first();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const updates = {};
  const oldValues = {};
  const newValues = {};

  for (const field of ['name', 'email', 'role']) {
    if (req.validated[field] !== undefined && req.validated[field] !== user[field]) {
      oldValues[field] = user[field];
      newValues[field] = req.validated[field];
      updates[field]   = req.validated[field];
    }
  }

  if (req.validated.email && req.validated.email !== user.email) {
    const exists = await db('users').where('email', req.validated.email).whereNot('id', id).first();
    if (exists) return res.status(422).json({ errors: { email: ['Email already in use'] } });
  }

  if (req.validated.password) {
    updates.password = await bcrypt.hash(req.validated.password, 12);
    newValues.password = '(changed)';
  }

  if (Object.keys(updates).length === 0) {
    return res.json({ message: 'No changes' });
  }

  await db('users').where('id', id).update(updates);
  await recordAudit(db, req, {
    action: 'user.update', subjectType: 'user', subjectId: id, oldValues, newValues,
  });

  res.json({ message: 'User updated' });
});

// DELETE /api/admin/users/:id — delete
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  // Prevent self-delete
  if (Number(id) === req.session.user.id) {
    return res.status(422).json({ error: 'Cannot delete yourself' });
  }

  const user = await db('users').where('id', id).first();
  if (!user) return res.status(404).json({ error: 'User not found' });

  await db('users').where('id', id).del();
  await recordAudit(db, req, {
    action: 'user.delete', subjectType: 'user', subjectId: id,
    oldValues: { name: user.name, email: user.email, role: user.role },
  });

  res.json({ message: 'User deleted' });
});

export default router;
