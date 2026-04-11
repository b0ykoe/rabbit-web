/**
 * Web authentication middleware.
 * Session-based — checks req.session.user set by the login route.
 */

/** Require any authenticated user. */
export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

/** Require authenticated admin user. */
export function requireAdmin(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/** Block all admin/portal API calls if force_password_change is true. */
export function checkForcePasswordChange(req, res, next) {
  if (req.session?.user?.force_password_change) {
    return res.status(403).json({
      error: 'Password change required',
      code:  'FORCE_PASSWORD_CHANGE',
    });
  }
  next();
}
