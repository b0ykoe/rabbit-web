import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { recordAudit } from '../services/auditLog.js';
import { validate, createUserSchema, updateUserSchema, adjustCreditsSchema } from '../validation/schemas.js';

const router = Router();

// GET /api/admin/users — paginated list
router.get('/', async (req, res) => {
  const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = 25;
  const offset = (page - 1) * limit;

  const [users, countResult] = await Promise.all([
    db('users')
      .select('id', 'name', 'email', 'role', 'credits', 'allowed_channels', 'status', 'hwid_reset_enabled', 'force_password_change', 'created_at')
      .orderBy('id', 'asc')
      .limit(limit)
      .offset(offset),
    db('users').count('* as total').first(),
  ]);

  // Parse JSON columns + attach license count
  if (users.length) {
    for (const u of users) {
      u.allowed_channels = u.allowed_channels ? JSON.parse(u.allowed_channels) : ['release'];
    }
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
  const { name, email, password, role, allowed_channels, status, hwid_reset_enabled } = req.validated;

  const exists = await db('users').where('email', email).first();
  if (exists) {
    return res.status(422).json({ errors: { email: ['Email already in use'] } });
  }

  const hash = await bcrypt.hash(password, 12);
  const [id] = await db('users').insert({
    name, email, password: hash, role,
    allowed_channels: JSON.stringify(allowed_channels),
    status: status || null,
    hwid_reset_enabled: hwid_reset_enabled ?? true,
  });

  await recordAudit(db, req, {
    action: 'user.create', subjectType: 'user', subjectId: id,
    newValues: { name, email, role, allowed_channels, status },
  });

  res.status(201).json({ id, name, email, role, allowed_channels });
});

// PATCH /api/admin/users/:id — update
router.patch('/:id', validate(updateUserSchema), async (req, res) => {
  const { id } = req.params;
  const user = await db('users').where('id', id).first();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const updates = {};
  const oldValues = {};
  const newValues = {};

  for (const field of ['name', 'email', 'role', 'status']) {
    if (req.validated[field] !== undefined && req.validated[field] !== user[field]) {
      oldValues[field] = user[field];
      newValues[field] = req.validated[field];
      updates[field]   = req.validated[field];
    }
  }

  if (req.validated.allowed_channels !== undefined) {
    const currentChannels = user.allowed_channels ? JSON.parse(user.allowed_channels) : ['release'];
    const newChannels = req.validated.allowed_channels;
    if (JSON.stringify(currentChannels) !== JSON.stringify(newChannels)) {
      oldValues.allowed_channels = currentChannels;
      newValues.allowed_channels = newChannels;
      updates.allowed_channels = JSON.stringify(newChannels);
    }
  }

  if (req.validated.email && req.validated.email !== user.email) {
    const exists = await db('users').where('email', req.validated.email).whereNot('id', id).first();
    if (exists) return res.status(422).json({ errors: { email: ['Email already in use'] } });
  }

  if (req.validated.hwid_reset_enabled !== undefined && req.validated.hwid_reset_enabled !== !!user.hwid_reset_enabled) {
    oldValues.hwid_reset_enabled = !!user.hwid_reset_enabled;
    newValues.hwid_reset_enabled = req.validated.hwid_reset_enabled;
    updates.hwid_reset_enabled = req.validated.hwid_reset_enabled;
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

// PATCH /api/admin/users/:id/credits — adjust credits
router.patch('/:id/credits', validate(adjustCreditsSchema), async (req, res) => {
  const { id } = req.params;
  const { credits } = req.validated;

  const user = await db('users').where('id', id).first();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const newCredits = Math.max(0, user.credits + credits);
  await db('users').where('id', id).update({ credits: newCredits });

  await recordAudit(db, req, {
    action: 'user.credits', subjectType: 'user', subjectId: id,
    oldValues: { credits: user.credits },
    newValues: { credits: newCredits, adjustment: credits },
  });

  res.json({ credits: newCredits, message: `Credits adjusted by ${credits >= 0 ? '+' : ''}${credits}` });
});

// DELETE /api/admin/users/:id — delete
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

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
