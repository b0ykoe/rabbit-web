import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

function createLimiter(windowMs, max, keyGenerator) {
  const opts = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    },
  };
  if (keyGenerator) {
    opts.keyGenerator = keyGenerator;
  }
  return rateLimit(opts);
}

const bySession = (req) =>
  req.session?.user?.id?.toString() || ipKeyGenerator(req.ip);

// W-3: per-session key for heartbeat — contained blast radius if one
// session is compromised. Only use AFTER validateBotToken has populated
// req.botToken (session_id is trusted at that point). Falls back to IP
// if for some reason the token wasn't verified.
const byBotSession = (req) =>
  req.botToken?.session_id || ipKeyGenerator(req.ip);

// Bot API — stateless, default IP key
export const botLoginLimiter     = createLimiter(60_000, 10);
export const botAuthStartLimiter = createLimiter(60_000, 10);
export const botHeartbeatLimiter = createLimiter(60_000, 600);   // 10s interval = 6/min/session
export const botHeartbeatSessionLimiter = createLimiter(60_000, 120, byBotSession); // bucket per session
export const botEndLimiter       = createLimiter(60_000, 30);
export const botDownloadLimiter  = createLimiter(60_000, 10);
export const botInfoLimiter      = createLimiter(60_000, 30);

// Web — session-aware for admin/portal, default IP for auth
export const botConfigLimiter   = createLimiter(60_000, 30);
export const webAuthLimiter = createLimiter(60_000, 10);
export const adminLimiter   = createLimiter(60_000, 100, bySession);
export const portalLimiter  = createLimiter(60_000, 60,  bySession);
