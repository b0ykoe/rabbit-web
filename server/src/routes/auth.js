import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { setCsrfCookie } from '../middleware/csrf.js';
import { validate, loginSchema, changePasswordSchema } from '../validation/schemas.js';

const router = Router();

// GET /api/auth/me — current authenticated user (fresh from DB)
router.get('/me', async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  // Refresh from DB to get latest credits/channels
  const user = await db('users').where('id', req.session.user.id).first();
  if (!user) return res.status(401).json({ error: 'User not found' });

  req.session.user = {
    id:                    user.id,
    name:                  user.name,
    email:                 user.email,
    role:                  user.role,
    credits:               user.credits || 0,
    allowed_channels:      user.allowed_channels ? JSON.parse(user.allowed_channels) : ['release'],
    status:                user.status || null,
    hwid_reset_enabled:    !!user.hwid_reset_enabled,
    last_login_at:         user.last_login_at || null,
    force_password_change: !!user.force_password_change,
  };
  res.json(req.session.user);
});

// POST /api/auth/login
router.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password, remember } = req.validated;

  const user = await db('users').where('email', email).first();
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Update last login
  await db('users').where('id', user.id).update({ last_login_at: db.fn.now() });

  // Regenerate session (prevent fixation)
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });

    // Store user in session (no password)
    req.session.user = {
      id:                    user.id,
      name:                  user.name,
      email:                 user.email,
      role:                  user.role,
      credits:               user.credits || 0,
      allowed_channels:      user.allowed_channels ? JSON.parse(user.allowed_channels) : ['release'],
      force_password_change: !!user.force_password_change,
    };

    // Remember me: 30 days
    if (remember) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
    }

    // Set CSRF cookie
    setCsrfCookie(req, res);

    res.json(req.session.user);
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('bot_portal_sid');
    res.clearCookie('XSRF-TOKEN');
    res.json({ ok: true });
  });
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, validate(changePasswordSchema), async (req, res) => {
  const { password } = req.validated;
  const userId = req.session.user.id;

  const hash = await bcrypt.hash(password, 12);
  await db('users').where('id', userId).update({
    password:              hash,
    force_password_change: false,
  });

  // Update session
  req.session.user.force_password_change = false;

  res.json({ ok: true, message: 'Password updated' });
});

export default router;
