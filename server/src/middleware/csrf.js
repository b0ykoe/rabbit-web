/**
 * Double-submit cookie CSRF protection.
 *
 * Flow:
 *   1. After login, server sets a non-httpOnly cookie `XSRF-TOKEN` with a random value.
 *   2. React reads this cookie and sends it as `X-XSRF-TOKEN` header on mutating requests.
 *   3. This middleware checks that the header matches the cookie on POST/PATCH/DELETE.
 *
 * The cookie is NOT httpOnly so that JavaScript can read it (this is by design).
 * The session cookie IS httpOnly, so XSS cannot hijack the session.
 */

import crypto from 'node:crypto';

/**
 * Generate and set the XSRF-TOKEN cookie.
 * Call after login or on first authenticated request.
 */
export function setCsrfCookie(req, res) {
  if (!req.cookies?.['XSRF-TOKEN']) {
    const token = crypto.randomBytes(32).toString('hex');
    req.session.csrfToken = token;
    res.cookie('XSRF-TOKEN', token, {
      httpOnly: false,   // JS must read this
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path:     '/',
    });
  }
}

/**
 * Middleware: verify CSRF token on mutating requests.
 */
export function verifyCsrf(req, res, next) {
  // Skip safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const headerToken = req.headers['x-xsrf-token'];
  const sessionToken = req.session?.csrfToken;

  if (!headerToken || !sessionToken || headerToken !== sessionToken) {
    return res.status(403).json({ error: 'CSRF token mismatch' });
  }

  next();
}
