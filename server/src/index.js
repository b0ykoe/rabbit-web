import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import db from './db.js';
import { sessionMiddleware } from './middleware/session.js';
import { verifyCsrf, setCsrfCookie } from './middleware/csrf.js';
import { requireAuth, requireAdmin, checkForcePasswordChange } from './middleware/auth.js';
import { startSessionCleanup } from './services/sessionCleanup.js';
import {
  botLoginLimiter, botAuthStartLimiter, botHeartbeatLimiter, botEndLimiter,
  botDownloadLimiter, botInfoLimiter, botConfigLimiter,
  webAuthLimiter, adminLimiter, portalLimiter,
} from './middleware/rateLimiter.js';

// Routes
import authRoutes           from './routes/auth.js';
import botAuthRoutes        from './routes/bot.auth.js';
import botDownloadRoutes    from './routes/bot.download.js';
import botConfigRoutes      from './routes/bot.config.js';
import botConfigRecordsRoutes from './routes/bot.config.records.js';
import portalShareRoutes    from './routes/portal.share.js';
import adminDashboardRoutes from './routes/admin.dashboard.js';
import adminUsersRoutes     from './routes/admin.users.js';
import adminLicensesRoutes  from './routes/admin.licenses.js';
import adminReleasesRoutes  from './routes/admin.releases.js';
import adminSessionsRoutes  from './routes/admin.sessions.js';
import adminAuditRoutes     from './routes/admin.audit.js';
import adminStatusesRoutes  from './routes/admin.statuses.js';
import portalDashboardRoutes from './routes/portal.dashboard.js';
import portalKeysRoutes     from './routes/portal.keys.js';
import portalRedeemRoutes   from './routes/portal.redeem.js';
import portalShopRoutes     from './routes/portal.shop.js';
import portalDownloadRoutes from './routes/portal.download.js';
import portalStatusesRoutes from './routes/portal.statuses.js';
import portalResetHwidRoutes from './routes/portal.reset-hwid.js';
import portalSessionsRoutes from './routes/portal.sessions.js';
import adminSettingsRoutes  from './routes/admin.settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read our own version from server/package.json — exposed at boot-time
// via the /api/version endpoint and printed to the startup log so ops
// can confirm which build is actually running.
const SERVER_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
).version;

const app = express();
app.set('trust proxy', 1);   // Cloudflare → CloudPanel/Nginx → Node

// Prefer Cloudflare's real-client-IP header. CF sets `CF-Connecting-IP`
// on every request; `X-Forwarded-For` sometimes gets rewritten by
// intermediate proxies (CloudPanel's Nginx). This override makes
// audit-logs / rate-limits / bot_sessions.ip_address see the end-user
// IP instead of a Cloudflare edge IP (104.21.*, 172.67.*, 188.114.*).
app.use((req, _res, next) => {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) {
    Object.defineProperty(req, 'ip', { get: () => cf, configurable: true });
  }
  next();
});

// ── Global Middleware ───────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false })); // CSP breaks CDN scripts
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CORS — only in dev (prod is same-origin)
if (!config.isProd) {
  app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
}

// Sessions — only for web routes, not bot API
app.use('/api/auth',   sessionMiddleware);
app.use('/api/admin',  sessionMiddleware);
app.use('/api/portal', sessionMiddleware);

// ── Rate Limiting ────────────────────────────────────────────────────────────

// Bot API (must be before route handlers)
app.use('/api/bot/auth/login',     botLoginLimiter);
app.use('/api/bot/auth/start',     botAuthStartLimiter);
app.use('/api/bot/auth/heartbeat', botHeartbeatLimiter);
app.use('/api/bot/auth/end',       botEndLimiter);
app.use('/api/bot/download',       botDownloadLimiter);
app.use('/api/bot/version',        botInfoLimiter);
app.use('/api/bot/changelog',      botInfoLimiter);
app.use('/api/bot/config',         botConfigLimiter);

// Web (applied before session/CSRF so rate limit rejects early)
app.use('/api/auth',               webAuthLimiter);
app.use('/api/admin',              adminLimiter);
app.use('/api/portal',             portalLimiter);

// ── Public: version probe (no auth, no CSRF) ────────────────────────────────

app.get('/api/version', (_req, res) => {
  res.json({ version: SERVER_VERSION });
});

// ── Bot API Routes (stateless, no session/CSRF) ─────────────────────────────

app.use('/api/bot/auth',     botAuthRoutes);
// New fact-based config endpoints (record/list/active/characters) are
// mounted first so they shadow nothing in the legacy router. Legacy paths
// (/global, /character, /hwid, /ip-profiles) live in botConfigRoutes and
// are now backed by the same tables via a shim.
app.use('/api/bot/config',   botConfigRecordsRoutes);
app.use('/api/bot/config',   botConfigRoutes);
app.use('/api/bot',          botDownloadRoutes);

// ── Web Auth Routes ──────────────────────────────────────────────────────────

app.use('/api/auth', authRoutes);

// ── CSRF + Auth for admin/portal routes ──────────────────────────────────────

// Ensure CSRF cookie is set on every authenticated request
app.use('/api/admin',  (req, res, next) => { setCsrfCookie(req, res); next(); });
app.use('/api/portal', (req, res, next) => { setCsrfCookie(req, res); next(); });

// Apply CSRF verification to admin/portal mutating requests
app.use('/api/admin',  verifyCsrf);
app.use('/api/portal', verifyCsrf);

// Apply auth + force-password-change check
app.use('/api/admin',  requireAdmin, checkForcePasswordChange);
app.use('/api/portal', requireAuth,  checkForcePasswordChange);

// ── Admin API Routes ─────────────────────────────────────────────────────────

app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/admin/users',     adminUsersRoutes);
app.use('/api/admin/licenses',  adminLicensesRoutes);
app.use('/api/admin/releases',  adminReleasesRoutes);
app.use('/api/admin/sessions',  adminSessionsRoutes);
app.use('/api/admin/audit',     adminAuditRoutes);
app.use('/api/admin/statuses',  adminStatusesRoutes);
app.use('/api/admin/settings',  adminSettingsRoutes);

// ── Portal API Routes ────────────────────────────────────────────────────────

app.use('/api/portal/dashboard', portalDashboardRoutes);
app.use('/api/portal/keys',      portalKeysRoutes);
app.use('/api/portal/redeem',    portalRedeemRoutes);
app.use('/api/portal/statuses',  portalStatusesRoutes);
app.use('/api/portal/shop',      portalShopRoutes);
app.use('/api/portal/download',  portalDownloadRoutes);
app.use('/api/portal/reset-hwid', portalResetHwidRoutes);
app.use('/api/portal/sessions',  portalSessionsRoutes);

// ── Public share landing page (no auth) ──────────────────────────────────────
// Server-rendered HTML at /share/:id. Mounted before the SPA fallback so
// browser visits land on this page instead of the React app's 404. The bot
// API endpoint /api/bot/config/share/:id stays authenticated; this public
// page only exposes metadata (source name, kind, tabs, key count) — never
// the actual config values.
app.use('/', portalShareRoutes);

// ── Static Files (React build — production only) ─────────────────────────────
// In dev, Vite serves the frontend on :5173 and proxies /api to Express.

if (config.isProd) {
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist));

  // SPA fallback — serve index.html for non-API routes
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// 404 for unknown API routes (works in both dev and prod)
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error Handler ────────────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error('[error]', err.stack || err.message);
  res.status(500).json({ error: config.isProd ? 'Internal server error' : err.message });
});

// ── Start ────────────────────────────────────────────────────────────────────

const port = config.port;
app.listen(port, () => {
  console.log(`[server] Rabbit v${SERVER_VERSION} running on http://localhost:${port}`);
  console.log(`[server] Environment: ${config.env}`);
});

// Start stale session cleanup (every 60s)
startSessionCleanup(db);
