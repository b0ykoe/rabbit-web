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

// Per-token bucket for endpoints that run BEFORE validateBotToken (so
// req.botToken isn't populated yet). Uses the raw bearer token (or
// body.token) string as bucket key — no signature check, just a stable
// per-credential identifier so multiple Loader/Bot instances on the
// same NAT'd PC don't share an IP-quota with strangers. Forged tokens
// land in their own buckets and remain rejected by validateBotToken
// downstream, so the worst case is self-DoS by reusing an unsigned token.
const byBotToken = (req) => {
  const auth = req.headers?.authorization;
  let tokenB64 = null;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    tokenB64 = auth.slice(7);
  } else if (typeof req.body?.token === 'string') {
    tokenB64 = req.body.token;
  }
  if (tokenB64 && tokenB64.length >= 32) {
    return 'tok:' + tokenB64.slice(0, 64);
  }
  return ipKeyGenerator(req.ip);
};

// Bot API — stateless, default IP key
export const botLoginLimiter     = createLimiter(60_000, 10);
export const botAuthStartLimiter = createLimiter(60_000, 10);
export const botHeartbeatLimiter = createLimiter(60_000, 600);   // 10s interval = 6/min/session
export const botHeartbeatSessionLimiter = createLimiter(60_000, 120, byBotSession); // bucket per session
export const botEndLimiter       = createLimiter(60_000, 30);
export const botDownloadLimiter  = createLimiter(60_000, 10);
// Per-token: every Loader instance and Bot session gets its own quota,
// so multiple loaders + a running DLL on the same PC don't fight over
// a shared 30/min IP bucket. 120/min covers /version + /changelog at
// the 10s tick (12/min) plus headroom.
export const botInfoLimiter      = createLimiter(60_000, 120, byBotToken);

// Per-token: same rationale as botInfoLimiter. With a 10s background
// refresh issuing 4 list calls per tick (24/min/loader idle), 200/min
// gives one loader plenty of headroom, plus initial-login burst (8 reqs)
// and concurrent saves from a DLL. IP-shared 30/min was insufficient for
// even a single loader and made multi-instance unusable.
export const botConfigLimiter   = createLimiter(60_000, 200, byBotToken);
export const webAuthLimiter = createLimiter(60_000, 10);
export const adminLimiter   = createLimiter(60_000, 100, bySession);
export const portalLimiter  = createLimiter(60_000, 60,  bySession);
