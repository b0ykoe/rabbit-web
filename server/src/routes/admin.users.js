import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { recordAudit } from '../services/auditLog.js';
import { validate, createUserSchema, updateUserSchema, adjustCreditsSchema } from '../validation/schemas.js';
import { isSuperAdmin } from '../middleware/auth.js';

const router = Router();

/**
 * Only super-admins may assign the `admin` or `super_admin` role. Plain
 * admins can create/promote user accounts up to `user` role only.
 * Returns a 403-response object if the caller is not permitted, else null.
 */
function checkRoleAssignmentAllowed(req, targetRole) {
  if (!targetRole || targetRole === 'user') return null;
  if (isSuperAdmin(req)) return null;
  return { status: 403, body: { error: 'Only super_admin can assign admin roles' } };
}

// GET /api/admin/users — paginated list
router.get('/', async (req, res) => {
  const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = 25;
  const offset = (page - 1) * limit;

  const [users, countResult] = await Promise.all([
    db('users')
      .select('id', 'name', 'email', 'role', 'credits', 'allowed_channels', 'status', 'hwid_reset_enabled', 'force_password_change', 'feature_flags', 'created_at')
      .orderBy('id', 'asc')
      .limit(limit)
      .offset(offset),
    db('users').count('* as total').first(),
  ]);

  // Parse JSON columns + attach license count
  if (users.length) {
    for (const u of users) {
      u.allowed_channels = u.allowed_channels ? JSON.parse(u.allowed_channels) : ['release'];
      u.feature_flags = u.feature_flags ? JSON.parse(u.feature_flags) : {};
      u.hwid_reset_enabled = !!u.hwid_reset_enabled;
      u.force_password_change = !!u.force_password_change;
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
  const { name, email, password, role, allowed_channels, status, hwid_reset_enabled, feature_flags } = req.validated;

  // Only super-admins can create admin or super_admin accounts.
  const denied = checkRoleAssignmentAllowed(req, role);
  if (denied) return res.status(denied.status).json(denied.body);

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
    feature_flags: feature_flags ? JSON.stringify(feature_flags) : null,
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

  // Role changes gated by super-admin. Also prevent a super-admin from
  // demoting themselves via this endpoint (would lock out their own
  // access); a super-admin must be demoted by another super-admin.
  if (req.validated.role !== undefined && req.validated.role !== user.role) {
    const denied = checkRoleAssignmentAllowed(req, req.validated.role);
    if (denied) return res.status(denied.status).json(denied.body);
    if (Number(id) === req.session.user.id && user.role === 'super_admin') {
      return res.status(422).json({ error: 'Cannot demote your own super_admin role' });
    }
  }

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

  if (req.validated.feature_flags !== undefined) {
    const currentFlags = user.feature_flags ? JSON.parse(user.feature_flags) : {};
    const newFlags = req.validated.feature_flags;
    if (JSON.stringify(currentFlags) !== JSON.stringify(newFlags)) {
      oldValues.feature_flags = currentFlags;
      newValues.feature_flags = newFlags;
      updates.feature_flags = JSON.stringify(newFlags);
    }
  }

  if (req.validated.password) {
    updates.password = await bcrypt.hash(req.validated.password, 12);
    newValues.password = '(changed)';
  }

  if (Object.keys(updates).length === 0) {
    return res.json({ message: 'No changes' });
  }

  await db('users').where('id', id).update(updates);

  // W-2: if role changed or password was force-reset here, any outstanding
  // tokens the user holds should stop working immediately.
  if (updates.role !== undefined || updates.password !== undefined) {
    await db('users').where('id', id).increment('token_version', 1);
  }

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

// GET /api/admin/users/:id/purchases — purchase history for a user
router.get('/:id/purchases', async (req, res) => {
  const { id } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 25;

  const query = db('audit_logs')
    .where('user_id', id)
    .whereIn('action', ['shop.purchase', 'shop.extend', 'shop.purchase_module']);

  const [{ count }] = await query.clone().count('* as count');
  const total = Number(count);
  const totalPages = Math.ceil(total / perPage);

  const rows = await query.clone()
    .orderBy('created_at', 'desc')
    .offset((page - 1) * perPage)
    .limit(perPage)
    .select('id', 'action', 'subject_type', 'subject_id', 'new_values', 'created_at');

  const data = rows.map((r) => {
    let newValues = {};
    try { newValues = r.new_values ? JSON.parse(r.new_values) : {}; } catch { /* empty */ }
    return {
      id: r.id,
      action: r.action,
      subject_id: r.subject_id,
      product_name: newValues.product_name || null,
      credits_cost: newValues.credits_cost || null,
      created_at: r.created_at,
    };
  });

  res.json({ data, total, totalPages });
});

export default router;
