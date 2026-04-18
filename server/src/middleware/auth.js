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

/**
 * Require authenticated admin user. Both `admin` and `super_admin` roles
 * pass this check — super-admin is strictly a superset of admin's
 * permissions plus the ability to promote other users (enforced
 * separately in admin.users.js).
 */
export function requireAdmin(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const role = req.session.user.role;
  if (role !== 'admin' && role !== 'super_admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Require authenticated super-admin user. Used to gate
 *   (1) role assignment to `admin` / `super_admin`,
 *   (2) IP address visibility in session listings,
 *   (3) any future sensitive surface.
 */
export function requireSuperAdmin(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super-admin access required' });
  }
  next();
}

/** Helper for inline checks (e.g. hiding fields in a response). */
export function isSuperAdmin(req) {
  return req.session?.user?.role === 'super_admin';
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
